//! The render thread. It owns the terminal: every print, live update and
//! prompt is a message to it, so output ordering is the order of calls and the
//! live region is never overwritten by a stray write.

use std::collections::BTreeMap;
use std::io::{self, IsTerminal, Stderr, Write};
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossterm::event::{self, DisableBracketedPaste, EnableBracketedPaste, Event};
use crossterm::{cursor, execute, terminal};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::Position;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};
use ratatui::{Terminal, TerminalOptions, Viewport};
use unicode_width::UnicodeWidthStr;

use crate::live::{Node, TICK_MS};
use crate::prompt::{Answer, Outcome, Prompt, PromptError};
use crate::{Mode, Options, ansi, theme};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Target {
    Stdout,
    Stderr,
}

type Reply = Sender<Result<Answer, PromptError>>;

enum Msg {
    Print(Target, Vec<Line<'static>>),
    Upsert(u64, Node),
    Update(u64, Box<dyn FnOnce(&mut Node) + Send>),
    Remove(u64, Vec<Line<'static>>),
    Prompt(u64, Prompt, Reply),
    Shutdown(Sender<()>),
}

pub(crate) struct Runtime {
    mode: Mode,
    can_prompt: bool,
    stdout_tty: bool,
    stderr_tty: bool,
    tx: Mutex<Option<Sender<Msg>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

fn env_flag(name: &str, value: &str) -> bool {
    std::env::var(name).is_ok_and(|v| v == value)
}

impl Runtime {
    pub(crate) fn start(options: Options) -> Self {
        let stdout_tty = io::stdout().is_terminal();
        let stderr_tty = io::stderr().is_terminal();
        let dumb = env_flag("TERM", "dumb");
        let quiet = options.quiet || env_flag("WISPCTL_NO_PROGRESS", "1") || env_flag("CI", "true");
        let interactive = stderr_tty && !dumb;

        if !stderr_tty && !stdout_tty {
            theme::set_support(theme::ColorSupport::None);
        }

        let mode = if interactive && !quiet {
            Mode::Rich
        } else {
            Mode::Plain
        };
        let (tx, thread) = if interactive {
            let (tx, rx) = mpsc::channel();
            let thread = std::thread::Builder::new()
                .name("wisp-ui".into())
                .spawn(move || Renderer::new(stdout_tty).run(rx))
                .ok();
            install_panic_hook();
            (Some(tx), thread)
        } else {
            (None, None)
        };

        Self {
            mode,
            can_prompt: interactive && io::stdin().is_terminal(),
            stdout_tty,
            stderr_tty,
            tx: Mutex::new(tx),
            thread: Mutex::new(thread),
        }
    }

    pub(crate) fn mode(&self) -> Mode {
        self.mode
    }

    pub(crate) fn can_prompt(&self) -> bool {
        self.can_prompt && self.tx.lock().is_ok_and(|tx| tx.is_some())
    }

    /// Hand `msg` to the renderer, or give it back when none is running.
    fn send(&self, msg: Msg) -> Option<Msg> {
        let guard = self.tx.lock().ok();
        match guard.as_ref().and_then(|tx| tx.as_ref()) {
            Some(tx) => tx.send(msg).err().map(|e| e.0),
            None => Some(msg),
        }
    }

    pub(crate) fn print(&self, target: Target, lines: Vec<Line<'static>>) {
        if let Some(Msg::Print(target, lines)) = self.send(Msg::Print(target, lines)) {
            let tty = match target {
                Target::Stdout => self.stdout_tty,
                Target::Stderr => self.stderr_tty,
            };
            write_direct(target, &lines, tty);
        }
    }

    pub(crate) fn upsert(&self, id: u64, node: Node) {
        if self.mode == Mode::Rich {
            self.send(Msg::Upsert(id, node));
        }
    }

    pub(crate) fn update(&self, id: u64, f: impl FnOnce(&mut Node) + Send + 'static) {
        if self.mode == Mode::Rich {
            self.send(Msg::Update(id, Box::new(f)));
        }
    }

    pub(crate) fn remove(&self, id: u64, lines: Vec<Line<'static>>) {
        if self.mode == Mode::Rich {
            self.send(Msg::Remove(id, lines));
        } else if !lines.is_empty() {
            self.print(Target::Stderr, lines);
        }
    }

    pub(crate) fn prompt(&self, prompt: Prompt) -> Result<Answer, PromptError> {
        if !self.can_prompt {
            return Err(PromptError::NotInteractive);
        }
        let (reply, answer) = mpsc::channel();
        if self
            .send(Msg::Prompt(crate::next_id(), prompt, reply))
            .is_some()
        {
            return Err(PromptError::NotInteractive);
        }
        answer.recv().unwrap_or(Err(PromptError::Cancelled))
    }

    pub(crate) fn shutdown(&self) {
        let Some(tx) = self.tx.lock().ok().and_then(|mut tx| tx.take()) else {
            return;
        };
        let (done, wait) = mpsc::channel();
        if tx.send(Msg::Shutdown(done)).is_ok() {
            let _ = wait.recv_timeout(Duration::from_secs(1));
        }
        if let Some(thread) = self.thread.lock().ok().and_then(|mut t| t.take()) {
            let _ = thread.join();
        }
    }
}

fn write_direct(target: Target, lines: &[Line<'static>], tty: bool) {
    let styled = tty && theme::support() != theme::ColorSupport::None;
    let text: String = lines
        .iter()
        .map(|l| ansi::render(l, styled) + "\n")
        .collect();
    let _ = match target {
        Target::Stdout => io::stdout().lock().write_all(text.as_bytes()),
        Target::Stderr => io::stderr().lock().write_all(text.as_bytes()),
    };
}

/// Put the terminal back if the process panics mid-render.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = terminal::disable_raw_mode();
        let _ = execute!(io::stderr(), DisableBracketedPaste, cursor::Show);
        previous(info);
    }));
}

/// Hard-wrap a line to `width` columns so inserted scrollback text takes
/// exactly the rows we reserve for it.
fn wrap(line: &Line<'static>, width: usize) -> Vec<Line<'static>> {
    if width == 0 || line.width() <= width {
        return vec![line.clone()];
    }
    let mut rows = vec![Vec::new()];
    let mut used = 0;
    for span in &line.spans {
        let mut chunk = String::new();
        for c in span.content.chars() {
            let w = UnicodeWidthStr::width(c.encode_utf8(&mut [0; 4]) as &str);
            if used + w > width {
                if !chunk.is_empty() {
                    rows.last_mut()
                        .unwrap()
                        .push(Span::styled(std::mem::take(&mut chunk), span.style));
                }
                rows.push(Vec::new());
                used = 0;
            }
            chunk.push(c);
            used += w;
        }
        if !chunk.is_empty() {
            rows.last_mut()
                .unwrap()
                .push(Span::styled(chunk, span.style));
        }
    }
    rows.into_iter().map(Line::from).collect()
}

struct ActivePrompt {
    id: u64,
    reply: Reply,
}

struct Renderer {
    term: Option<Terminal<CrosstermBackend<Stderr>>>,
    height: u16,
    nodes: BTreeMap<u64, Node>,
    prompt: Option<ActivePrompt>,
    raw: bool,
    started: Instant,
    stdout_tty: bool,
}

impl Renderer {
    fn new(stdout_tty: bool) -> Self {
        Self {
            term: None,
            height: 0,
            nodes: BTreeMap::new(),
            prompt: None,
            raw: false,
            started: Instant::now(),
            stdout_tty,
        }
    }

    fn tick(&self) -> u64 {
        self.started.elapsed().as_millis() as u64 / TICK_MS
    }

    fn run(mut self, rx: Receiver<Msg>) {
        loop {
            let wait = if self.prompt.is_some() {
                Duration::from_millis(15)
            } else if self.nodes.values().any(Node::animated) {
                Duration::from_millis(TICK_MS)
            } else {
                Duration::from_millis(500)
            };
            match rx.recv_timeout(wait) {
                Ok(msg) => {
                    if !self.handle(msg) {
                        return;
                    }
                    while let Ok(msg) = rx.try_recv() {
                        if !self.handle(msg) {
                            return;
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    self.teardown();
                    return;
                }
            }
            self.poll_input();
            self.draw();
        }
    }

    /// Returns false once the renderer has shut down.
    fn handle(&mut self, msg: Msg) -> bool {
        match msg {
            Msg::Print(target, lines) => self.print(target, lines),
            Msg::Upsert(id, node) => {
                self.nodes.insert(id, node);
            }
            Msg::Update(id, f) => {
                if let Some(node) = self.nodes.get_mut(&id) {
                    f(node);
                }
            }
            Msg::Remove(id, lines) => self.remove(id, lines),
            Msg::Prompt(id, prompt, reply) => self.start_prompt(id, prompt, reply),
            Msg::Shutdown(done) => {
                self.teardown();
                let _ = done.send(());
                return false;
            }
        }
        true
    }

    fn width(&self) -> u16 {
        terminal::size().map(|(w, _)| w).unwrap_or(80)
    }

    fn render_nodes(&self) -> Vec<Line<'static>> {
        let (width, tick) = (self.width(), self.tick());
        self.nodes
            .values()
            .flat_map(|node| node.render(width, tick))
            .collect()
    }

    /// Resize the inline viewport to `height` rows, recreating the terminal
    /// at the top of the old region (ratatui fixes an inline viewport's height
    /// at construction).
    fn set_height(&mut self, height: u16) {
        if height == self.height && (height == 0) == self.term.is_none() {
            return;
        }
        if let Some(mut term) = self.term.take() {
            let top = term.get_frame().area().y;
            let _ = term.clear();
            let _ = term.set_cursor_position(Position::new(0, top));
        }
        self.height = height;
        if height > 0 {
            let backend = CrosstermBackend::new(io::stderr());
            let options = TerminalOptions {
                viewport: Viewport::Inline(height),
            };
            self.term = Terminal::with_options(backend, options).ok();
        } else {
            let _ = execute!(io::stderr(), cursor::Show);
        }
    }

    fn draw(&mut self) {
        let lines = self.render_nodes();
        let rows = terminal::size().map(|(_, h)| h).unwrap_or(24);
        let height = (lines.len() as u16).min(rows.saturating_sub(1));
        self.set_height(height);
        if let Some(term) = self.term.as_mut() {
            let _ = term.draw(|frame| {
                let area = frame.area();
                Paragraph::new(lines).render(area, frame.buffer_mut());
            });
        }
    }

    fn print(&mut self, target: Target, lines: Vec<Line<'static>>) {
        let through_viewport = match target {
            Target::Stderr => true,
            Target::Stdout => self.stdout_tty,
        };
        match self.term.as_mut() {
            Some(term) if through_viewport => {
                let width = term.size().map(|s| s.width).unwrap_or(80) as usize;
                let rows: Vec<Line<'static>> = lines.iter().flat_map(|l| wrap(l, width)).collect();
                // insert_before draws at most a screenful per call.
                for chunk in rows.chunks(200) {
                    let chunk = chunk.to_vec();
                    let _ = term.insert_before(chunk.len() as u16, |buf| {
                        Paragraph::new(chunk).render(buf.area, buf);
                    });
                }
            }
            _ => {
                let tty = match target {
                    Target::Stdout => self.stdout_tty,
                    Target::Stderr => true,
                };
                if self.raw {
                    let _ = terminal::disable_raw_mode();
                }
                write_direct(target, &lines, tty);
                if self.raw {
                    let _ = terminal::enable_raw_mode();
                }
            }
        }
    }

    fn remove(&mut self, id: u64, lines: Vec<Line<'static>>) {
        if self.nodes.remove(&id).is_none() && lines.is_empty() {
            return;
        }
        self.draw();
        if !lines.is_empty() {
            self.print(Target::Stderr, lines);
        }
    }

    fn start_prompt(&mut self, id: u64, prompt: Prompt, reply: Reply) {
        if self.prompt.is_some() {
            let _ = reply.send(Err(PromptError::NotInteractive));
            return;
        }
        if terminal::enable_raw_mode().is_err() {
            let _ = reply.send(Err(PromptError::NotInteractive));
            return;
        }
        self.raw = true;
        let _ = execute!(io::stderr(), EnableBracketedPaste);
        self.nodes.insert(id, Node::Prompt(prompt));
        self.prompt = Some(ActivePrompt { id, reply });
    }

    fn finish_prompt(&mut self, outcome: Result<Answer, PromptError>) {
        let Some(active) = self.prompt.take() else {
            return;
        };
        let summary = match (self.nodes.get(&active.id), &outcome) {
            (Some(Node::Prompt(prompt)), Ok(answer)) => prompt.summary(answer),
            (Some(Node::Prompt(prompt)), Err(_)) => prompt.cancelled_summary(),
            _ => Line::default(),
        };
        let _ = execute!(io::stderr(), DisableBracketedPaste);
        let _ = terminal::disable_raw_mode();
        self.raw = false;
        self.remove(active.id, vec![summary]);
        let _ = active.reply.send(outcome);
    }

    fn poll_input(&mut self) {
        let Some(id) = self.prompt.as_ref().map(|p| p.id) else {
            return;
        };
        while event::poll(Duration::ZERO).unwrap_or(false) {
            let Ok(event) = event::read() else { break };
            let Some(Node::Prompt(prompt)) = self.nodes.get_mut(&id) else {
                return;
            };
            let outcome = match event {
                Event::Key(key) => prompt.handle_key(key),
                Event::Paste(text) => {
                    prompt.paste(&text);
                    Outcome::Pending
                }
                _ => Outcome::Pending,
            };
            match outcome {
                Outcome::Pending => {}
                Outcome::Done(answer) => return self.finish_prompt(Ok(answer)),
                Outcome::Cancelled => return self.finish_prompt(Err(PromptError::Cancelled)),
            }
        }
    }

    fn teardown(&mut self) {
        if self.prompt.is_some() {
            self.finish_prompt(Err(PromptError::Cancelled));
        }
        self.nodes.clear();
        self.draw();
        self.set_height(0);
        if self.raw {
            let _ = terminal::disable_raw_mode();
        }
        let _ = execute!(io::stderr(), cursor::Show);
        let _ = io::stderr().flush();
    }
}

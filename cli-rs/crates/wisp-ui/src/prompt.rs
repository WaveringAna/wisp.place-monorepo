//! Prompt state machines. Pure: a key goes in, a new state or an outcome comes
//! out, and rendering is a function of the state. The runtime owns the I/O.

use std::fmt;

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use crate::theme::{accent_style, danger_style, muted_style, s};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptError {
    /// The user pressed Esc or Ctrl-C.
    Cancelled,
    /// There is no terminal to ask on (CI, piped stdin). The caller should
    /// tell the user which flag supplies the value instead.
    NotInteractive,
}

impl fmt::Display for PromptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => f.write_str("cancelled"),
            Self::NotInteractive => f.write_str("no terminal to prompt on"),
        }
    }
}

impl std::error::Error for PromptError {}

pub struct Choice<T> {
    pub value: T,
    pub label: String,
    pub hint: Option<String>,
}

impl<T> Choice<T> {
    pub fn new(value: T, label: impl Into<String>) -> Self {
        Self {
            value,
            label: label.into(),
            hint: None,
        }
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub(crate) fn display(&self) -> (String, Option<String>) {
        (self.label.clone(), self.hint.clone())
    }
}

type Validator = Box<dyn Fn(&str) -> Result<(), String> + Send>;

/// Builder for [`crate::text`].
pub struct TextPrompt {
    message: String,
    placeholder: Option<String>,
    default: Option<String>,
    validate: Option<Validator>,
}

impl TextPrompt {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            placeholder: None,
            default: None,
            validate: None,
        }
    }

    pub fn placeholder(mut self, placeholder: impl Into<String>) -> Self {
        self.placeholder = Some(placeholder.into());
        self
    }

    /// Submitted when the user presses enter on an empty input.
    pub fn default(mut self, default: impl Into<String>) -> Self {
        self.default = Some(default.into());
        self
    }

    /// Runs on submit; an `Err` message is shown under the input.
    pub fn validate(mut self, f: impl Fn(&str) -> Result<(), String> + Send + 'static) -> Self {
        self.validate = Some(Box::new(f));
        self
    }

    pub(crate) fn into_state(self) -> TextState {
        TextState {
            message: self.message,
            placeholder: self.placeholder,
            default: self.default,
            validate: self.validate,
            input: Vec::new(),
            cursor: 0,
            error: None,
        }
    }
}

pub(crate) struct TextState {
    message: String,
    placeholder: Option<String>,
    default: Option<String>,
    validate: Option<Validator>,
    input: Vec<char>,
    cursor: usize,
    error: Option<String>,
}

pub(crate) struct SelectState {
    message: String,
    options: Vec<(String, Option<String>)>,
    selected: usize,
}

pub(crate) struct ConfirmState {
    message: String,
    value: bool,
}

pub(crate) enum Prompt {
    Text(TextState),
    Select(SelectState),
    Confirm(ConfirmState),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Answer {
    Text(String),
    Index(usize),
    Bool(bool),
}

impl Answer {
    pub(crate) fn into_text(self) -> String {
        match self {
            Self::Text(text) => text,
            _ => unreachable!("text prompt answered with a non-text value"),
        }
    }
    pub(crate) fn into_index(self) -> usize {
        match self {
            Self::Index(index) => index,
            _ => unreachable!("select prompt answered with a non-index value"),
        }
    }
    pub(crate) fn into_bool(self) -> bool {
        match self {
            Self::Bool(value) => value,
            _ => unreachable!("confirm prompt answered with a non-bool value"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Pending,
    Done(Answer),
    Cancelled,
}

/// Rows of options a select shows at once before it scrolls.
const SELECT_WINDOW: usize = 8;

impl SelectState {
    pub(crate) fn new(message: &str, options: Vec<(String, Option<String>)>) -> Self {
        Self {
            message: message.to_owned(),
            options,
            selected: 0,
        }
    }
}

impl ConfirmState {
    pub(crate) fn new(message: &str, initial: bool) -> Self {
        Self {
            message: message.to_owned(),
            value: initial,
        }
    }
}

fn is_cancel(key: &KeyEvent) -> bool {
    key.code == KeyCode::Esc
        || (key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('d')))
}

impl TextState {
    fn value(&self) -> String {
        self.input.iter().collect()
    }

    fn submit(&mut self) -> Outcome {
        let typed = self.value();
        let value = match (&self.default, typed.is_empty()) {
            (Some(default), true) => default.clone(),
            _ => typed,
        };
        match self.validate.as_ref().map(|f| f(&value)) {
            Some(Err(message)) => {
                self.error = Some(message);
                Outcome::Pending
            }
            _ => Outcome::Done(Answer::Text(value)),
        }
    }

    fn delete_word_before_cursor(&mut self) {
        let mut start = self.cursor;
        while start > 0 && self.input[start - 1].is_whitespace() {
            start -= 1;
        }
        while start > 0 && !self.input[start - 1].is_whitespace() {
            start -= 1;
        }
        self.input.drain(start..self.cursor);
        self.cursor = start;
    }

    fn handle(&mut self, key: KeyEvent) -> Outcome {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Enter => return self.submit(),
            KeyCode::Char('a') if ctrl => self.cursor = 0,
            KeyCode::Char('e') if ctrl => self.cursor = self.input.len(),
            KeyCode::Char('u') if ctrl => {
                self.input.drain(..self.cursor);
                self.cursor = 0;
            }
            KeyCode::Char('w') if ctrl => self.delete_word_before_cursor(),
            KeyCode::Char(c) if !ctrl => {
                self.input.insert(self.cursor, c);
                self.cursor += 1;
            }
            KeyCode::Backspace if self.cursor > 0 => {
                self.cursor -= 1;
                self.input.remove(self.cursor);
            }
            KeyCode::Delete if self.cursor < self.input.len() => {
                self.input.remove(self.cursor);
            }
            KeyCode::Left => self.cursor = self.cursor.saturating_sub(1),
            KeyCode::Right => self.cursor = (self.cursor + 1).min(self.input.len()),
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = self.input.len(),
            _ => return Outcome::Pending,
        }
        self.error = None;
        Outcome::Pending
    }

    fn paste(&mut self, text: &str) {
        let chars: Vec<char> = text.chars().filter(|c| !c.is_control()).collect();
        let n = chars.len();
        self.input.splice(self.cursor..self.cursor, chars);
        self.cursor += n;
        self.error = None;
    }

    fn render(&self) -> Vec<Line<'static>> {
        let cursor_style = Style::new().add_modifier(Modifier::REVERSED);
        let input_line = if self.input.is_empty() {
            let placeholder = self.placeholder.clone().or_else(|| self.default.clone());
            match placeholder {
                Some(p) => {
                    let mut chars = p.chars();
                    let first = chars.next().map(String::from).unwrap_or_else(|| " ".into());
                    Line::from(vec![
                        Span::raw("  "),
                        Span::styled(first, cursor_style.patch(muted_style())),
                        s::muted(chars.collect::<String>()),
                    ])
                }
                None => Line::from(vec![Span::raw("  "), Span::styled(" ", cursor_style)]),
            }
        } else {
            let before: String = self.input[..self.cursor].iter().collect();
            let at: String = self
                .input
                .get(self.cursor)
                .map(|c| c.to_string())
                .unwrap_or_else(|| " ".into());
            let after: String = self
                .input
                .get(self.cursor + 1..)
                .map(|r| r.iter().collect())
                .unwrap_or_default();
            Line::from(vec![
                Span::raw("  "),
                Span::raw(before),
                Span::styled(at, cursor_style),
                Span::raw(after),
            ])
        };
        let mut lines = vec![active_header(&self.message), input_line];
        if let Some(error) = &self.error {
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(error.clone(), danger_style()),
            ]));
        }
        lines
    }
}

impl SelectState {
    fn handle(&mut self, key: KeyEvent) -> Outcome {
        let last = self.options.len().saturating_sub(1);
        match key.code {
            KeyCode::Enter => return Outcome::Done(Answer::Index(self.selected)),
            KeyCode::Up | KeyCode::Char('k') | KeyCode::BackTab => {
                self.selected = if self.selected == 0 {
                    last
                } else {
                    self.selected - 1
                };
            }
            KeyCode::Down | KeyCode::Char('j') | KeyCode::Tab => {
                self.selected = if self.selected >= last {
                    0
                } else {
                    self.selected + 1
                };
            }
            KeyCode::Home | KeyCode::PageUp => self.selected = 0,
            KeyCode::End | KeyCode::PageDown => self.selected = last,
            _ => {}
        }
        Outcome::Pending
    }

    /// First visible option, keeping the selection inside the window.
    fn window_start(&self) -> usize {
        let len = self.options.len();
        if len <= SELECT_WINDOW {
            return 0;
        }
        let half = SELECT_WINDOW / 2;
        self.selected.saturating_sub(half).min(len - SELECT_WINDOW)
    }

    fn render(&self) -> Vec<Line<'static>> {
        let start = self.window_start();
        let end = (start + SELECT_WINDOW).min(self.options.len());
        let label_width = self.options[start..end]
            .iter()
            .map(|(l, _)| l.width())
            .max()
            .unwrap_or(0);

        let mut lines = vec![active_header(&self.message)];
        if start > 0 {
            lines.push(Line::from(vec![
                Span::raw("    "),
                s::muted(format!("↑ {start} more")),
            ]));
        }
        for (index, (label, hint)) in self.options.iter().enumerate().take(end).skip(start) {
            let focused = index == self.selected;
            let pad = " ".repeat(label_width - label.width());
            let mut spans = if focused {
                vec![
                    Span::raw("  "),
                    s::accent("› "),
                    Span::styled(label.clone(), accent_style().add_modifier(Modifier::BOLD)),
                ]
            } else {
                vec![Span::raw("    "), Span::raw(label.clone())]
            };
            if let Some(hint) = hint {
                spans.push(Span::raw(pad));
                spans.push(Span::raw("  "));
                spans.push(s::muted(hint.clone()));
            }
            lines.push(Line::from(spans));
        }
        let below = self.options.len() - end;
        if below > 0 {
            lines.push(Line::from(vec![
                Span::raw("    "),
                s::muted(format!("↓ {below} more")),
            ]));
        }
        lines.push(Line::from(vec![
            Span::raw("  "),
            s::muted("↑↓ move · enter select · esc cancel"),
        ]));
        lines
    }
}

impl ConfirmState {
    fn handle(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Enter => return Outcome::Done(Answer::Bool(self.value)),
            KeyCode::Char('y') | KeyCode::Char('Y') => return Outcome::Done(Answer::Bool(true)),
            KeyCode::Char('n') | KeyCode::Char('N') => return Outcome::Done(Answer::Bool(false)),
            KeyCode::Left
            | KeyCode::Right
            | KeyCode::Up
            | KeyCode::Down
            | KeyCode::Tab
            | KeyCode::BackTab => {
                self.value = !self.value;
            }
            KeyCode::Char('h') | KeyCode::Char('k') => self.value = true,
            KeyCode::Char('l') | KeyCode::Char('j') => self.value = false,
            _ => {}
        }
        Outcome::Pending
    }

    fn render(&self) -> Vec<Line<'static>> {
        let option = |label: &'static str, on: bool| -> Vec<Span<'static>> {
            if on {
                vec![
                    s::accent("● "),
                    Span::styled(label, Style::new().add_modifier(Modifier::BOLD)),
                ]
            } else {
                vec![s::muted("○ "), s::muted(label)]
            }
        };
        let mut spans = vec![Span::raw("  ")];
        spans.extend(option("Yes", self.value));
        spans.push(Span::raw("   "));
        spans.extend(option("No", !self.value));
        vec![active_header(&self.message), Line::from(spans)]
    }
}

fn active_header(message: &str) -> Line<'static> {
    Line::from(vec![s::accent("◆ "), s::bold(message.to_owned())])
}

impl Prompt {
    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        if key.kind == KeyEventKind::Release {
            return Outcome::Pending;
        }
        if is_cancel(&key) {
            return Outcome::Cancelled;
        }
        match self {
            Self::Text(state) => state.handle(key),
            Self::Select(state) => state.handle(key),
            Self::Confirm(state) => state.handle(key),
        }
    }

    pub(crate) fn paste(&mut self, text: &str) {
        if let Self::Text(state) = self {
            state.paste(text);
        }
    }

    pub(crate) fn render(&self) -> Vec<Line<'static>> {
        match self {
            Self::Text(state) => state.render(),
            Self::Select(state) => state.render(),
            Self::Confirm(state) => state.render(),
        }
    }

    fn message(&self) -> &str {
        match self {
            Self::Text(state) => &state.message,
            Self::Select(state) => &state.message,
            Self::Confirm(state) => &state.message,
        }
    }

    /// The single line a finished prompt collapses into.
    pub(crate) fn summary(&self, answer: &Answer) -> Line<'static> {
        let value = match (self, answer) {
            (Self::Select(state), Answer::Index(i)) => state.options[*i].0.clone(),
            (_, Answer::Text(text)) => text.clone(),
            (_, Answer::Bool(true)) => "Yes".into(),
            (_, Answer::Bool(false)) => "No".into(),
            (_, Answer::Index(i)) => i.to_string(),
        };
        Line::from(vec![
            s::muted("◇ "),
            s::muted(self.message().to_owned()),
            Span::raw("  "),
            Span::raw(value),
        ])
    }

    pub(crate) fn cancelled_summary(&self) -> Line<'static> {
        Line::from(vec![
            s::muted("■ "),
            Span::styled(
                self.message().to_owned(),
                muted_style().add_modifier(Modifier::CROSSED_OUT),
            ),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }

    fn type_str(prompt: &mut Prompt, text: &str) {
        for c in text.chars() {
            assert_eq!(prompt.handle_key(key(KeyCode::Char(c))), Outcome::Pending);
        }
    }

    #[test]
    fn text_edits_and_submits() {
        let mut p = Prompt::Text(TextPrompt::new("Site").into_state());
        type_str(&mut p, "my blg");
        p.handle_key(key(KeyCode::Left));
        type_str(&mut p, "o");
        assert_eq!(
            p.handle_key(key(KeyCode::Enter)),
            Outcome::Done(Answer::Text("my blog".into()))
        );
    }

    #[test]
    fn text_uses_default_when_empty() {
        let mut p = Prompt::Text(TextPrompt::new("Dir").default(".").into_state());
        assert_eq!(
            p.handle_key(key(KeyCode::Enter)),
            Outcome::Done(Answer::Text(".".into()))
        );
    }

    #[test]
    fn text_validation_blocks_until_fixed() {
        let mut p = Prompt::Text(
            TextPrompt::new("Handle")
                .validate(|v| {
                    if v.contains('.') {
                        Ok(())
                    } else {
                        Err("needs a dot".into())
                    }
                })
                .into_state(),
        );
        type_str(&mut p, "alice");
        assert_eq!(p.handle_key(key(KeyCode::Enter)), Outcome::Pending);
        assert!(
            p.render()
                .iter()
                .any(|l| l.to_string().contains("needs a dot"))
        );
        type_str(&mut p, ".test");
        assert!(
            !p.render()
                .iter()
                .any(|l| l.to_string().contains("needs a dot"))
        );
        assert_eq!(
            p.handle_key(key(KeyCode::Enter)),
            Outcome::Done(Answer::Text("alice.test".into()))
        );
    }

    #[test]
    fn text_ctrl_w_and_ctrl_u() {
        let mut p = Prompt::Text(TextPrompt::new("x").into_state());
        type_str(&mut p, "one two  ");
        p.handle_key(ctrl('w'));
        assert_eq!(
            p.handle_key(key(KeyCode::Enter)),
            Outcome::Done(Answer::Text("one ".into()))
        );
        let mut p = Prompt::Text(TextPrompt::new("x").into_state());
        type_str(&mut p, "abc");
        p.handle_key(ctrl('u'));
        p.paste("x\ny");
        assert_eq!(
            p.handle_key(key(KeyCode::Enter)),
            Outcome::Done(Answer::Text("xy".into()))
        );
    }

    #[test]
    fn escape_and_ctrl_c_cancel() {
        let mut p = Prompt::Confirm(ConfirmState::new("ok?", true));
        assert_eq!(p.handle_key(key(KeyCode::Esc)), Outcome::Cancelled);
        assert_eq!(p.handle_key(ctrl('c')), Outcome::Cancelled);
    }

    #[test]
    fn select_wraps_and_scrolls() {
        let options = (0..20).map(|i| (format!("site-{i}"), None)).collect();
        let mut p = Prompt::Select(SelectState::new("pick", options));
        p.handle_key(key(KeyCode::Up));
        let rendered: Vec<String> = p.render().iter().map(ToString::to_string).collect();
        assert!(rendered.iter().any(|l| l.contains("› site-19")));
        assert!(rendered.iter().any(|l| l.contains("↑ 12 more")));
        assert_eq!(
            p.handle_key(key(KeyCode::Enter)),
            Outcome::Done(Answer::Index(19))
        );
    }

    #[test]
    fn confirm_shortcuts() {
        let mut p = Prompt::Confirm(ConfirmState::new("ok?", true));
        assert_eq!(
            p.handle_key(key(KeyCode::Char('n'))),
            Outcome::Done(Answer::Bool(false))
        );
        let mut p = Prompt::Confirm(ConfirmState::new("ok?", true));
        p.handle_key(key(KeyCode::Right));
        assert_eq!(
            p.handle_key(key(KeyCode::Enter)),
            Outcome::Done(Answer::Bool(false))
        );
    }

    #[test]
    fn summaries_collapse_to_one_line() {
        let p = Prompt::Select(SelectState::new(
            "List",
            vec![("Domains".into(), None), ("Sites".into(), None)],
        ));
        assert_eq!(p.summary(&Answer::Index(1)).to_string(), "◇ List  Sites");
    }
}

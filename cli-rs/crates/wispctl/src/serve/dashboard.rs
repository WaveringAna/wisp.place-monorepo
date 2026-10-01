use std::sync::Mutex;
use wispplace_ui::{Line, Panel, PanelStatus, s};

#[derive(Clone)]
pub enum FirehoseStatus {
    Connecting,
    Connected,
    Error(String),
}
#[derive(Clone)]
pub enum SyncStatus {
    Idle,
    Pulling,
    Settings,
    Error(String),
}
struct Status {
    firehose: FirehoseStatus,
    sync: SyncStatus,
    files: usize,
    synced: String,
}

pub struct Dashboard {
    panel: Panel,
    url: String,
    site: String,
    status: Mutex<Status>,
}
impl Dashboard {
    pub fn new(url: String, site: String, files: usize) -> Self {
        let dashboard = Self {
            panel: wispplace_ui::panel(PanelStatus::Busy, vec![]),
            url,
            site,
            status: Mutex::new(Status {
                firehose: FirehoseStatus::Connecting,
                sync: SyncStatus::Idle,
                files,
                synced: super::log::timestamp(),
            }),
        };
        dashboard.render(&dashboard.status.lock().expect("dashboard lock"));
        dashboard
    }
    pub fn firehose(&self, firehose: FirehoseStatus) {
        let mut status = self.status.lock().expect("dashboard lock");
        status.firehose = firehose;
        self.render(&status);
    }
    pub fn sync(&self, sync: SyncStatus, files: Option<usize>) {
        let mut status = self.status.lock().expect("dashboard lock");
        if matches!(sync, SyncStatus::Idle) {
            status.synced = super::log::timestamp();
        }
        status.sync = sync;
        if let Some(files) = files {
            status.files = files;
        }
        self.render(&status);
    }
    /// Two lines under a status glyph:
    ///
    /// ```text
    /// ● serving my-blog  →  http://127.0.0.1:8080
    ///   firehose connected · synced 12:04:11 · 142 files
    /// ```
    fn render(&self, status: &Status) {
        let firehose = match &status.firehose {
            FirehoseStatus::Connecting => "firehose connecting".to_owned(),
            FirehoseStatus::Connected => "firehose connected".to_owned(),
            FirehoseStatus::Error(error) => format!("firehose reconnecting ({error})"),
        };
        let sync = match &status.sync {
            SyncStatus::Idle => format!("synced {}", status.synced),
            SyncStatus::Pulling => "re-pulling site".to_owned(),
            SyncStatus::Settings => "reloading settings".to_owned(),
            SyncStatus::Error(error) => format!("sync failed ({error})"),
        };
        let health = match (&status.firehose, &status.sync) {
            (FirehoseStatus::Error(_), _) | (_, SyncStatus::Error(_)) => PanelStatus::Error,
            (FirehoseStatus::Connecting, _) | (_, SyncStatus::Pulling | SyncStatus::Settings) => {
                PanelStatus::Busy
            }
            _ => PanelStatus::Live,
        };
        self.panel.set(
            health,
            vec![
                Line::from(vec![
                    s::bold(format!("serving {}", self.site)),
                    s::muted("  →  "),
                    s::link(self.url.clone()),
                ]),
                Line::from(s::muted(format!(
                    "{firehose} · {sync} · {} files",
                    status.files
                ))),
            ],
        );
    }
}

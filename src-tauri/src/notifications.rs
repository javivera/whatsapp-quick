//! Native macOS notifications, independent of WebView visibility/timer throttling.
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct IncomingMessage {
    sequence: u64,
    id: String,
    chat_id: String,
    timestamp: f64,
    title: String,
    subtitle: String,
    body: String,
}

#[derive(Deserialize)]
struct Feed {
    epoch: String,
    cursor: u64,
    events: Vec<IncomingMessage>,
}

#[derive(Default)]
struct Cursor {
    epoch: String,
    after: u64,
}

impl Cursor {
    fn consume(&mut self, feed: Feed) -> Vec<IncomingMessage> {
        let events = if self.epoch == feed.epoch {
            feed.events
                .into_iter()
                .filter(|event| event.sequence > self.after)
                .collect()
        } else {
            Vec::new() // Start/restart: baseline only, never flood with old messages.
        };
        self.epoch = feed.epoch;
        self.after = feed.cursor;
        events
    }
}

fn should_notify(message: &IncomingMessage, now: f64, visible_chat: Option<&str>) -> bool {
    let age = now - message.timestamp;
    !message.id.is_empty()
        && valid_chat_id(&message.chat_id)
        && (0.0..=120.0).contains(&age)
        && visible_chat != Some(message.chat_id.as_str())
}

pub fn valid_chat_id(id: &str) -> bool {
    let Some((number, domain)) = id.split_once('@') else {
        return false;
    };
    !number.is_empty()
        && number.len() <= 60
        && number
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
        && matches!(domain, "c.us" | "g.us" | "lid")
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use block2::RcBlock;
    use objc2::{define_class, msg_send, runtime::ProtocolObject, AnyThread, DefinedClass};
    use objc2_foundation::{NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tauri::{AppHandle, Manager};

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "WhatsAppQuickNotificationDelegate"]
        #[ivars = AppHandle]
        struct NotificationDelegate;

        unsafe impl NSObjectProtocol for NotificationDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn clicked(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &block2::DynBlock<dyn Fn()>,
            ) {
                if &*response.actionIdentifier() == unsafe { UNNotificationDefaultActionIdentifier }
                {
                    let chat_id = response
                        .notification()
                        .request()
                        .content()
                        .threadIdentifier()
                        .to_string();
                    let app = self.ivars().clone();
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if valid_chat_id(&chat_id) {
                            let mut url = tauri::Url::parse("whatsapp-quick://chat").unwrap();
                            url.query_pairs_mut().append_pair("id", &chat_id);
                            crate::receive_quick_link(&handle, &url);
                        } else {
                            crate::show_quick(&handle); // Test banner.
                        }
                    });
                }
                completion.call(());
            }
        }
    );

    pub fn start(app: &AppHandle) {
        let delegate = NotificationDelegate::alloc().set_ivars(app.clone());
        let delegate: objc2::rc::Retained<NotificationDelegate> =
            unsafe { msg_send![super(delegate), init] };
        UNUserNotificationCenter::currentNotificationCenter()
            .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center's delegate is weak. Retain this single delegate for app lifetime.
        Box::leak(Box::new(delegate));
        request_permission(std::env::var_os("QUICK_NOTIFICATION_TEST").is_some());
        let app = app.clone();
        std::thread::spawn(move || poll_feed(&app));
    }

    fn poll_feed(app: &AppHandle) {
        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(4))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                eprintln!("[notifications] HTTP client: {error}");
                return;
            }
        };
        let mut cursor = Cursor::default();
        let mut unsupported = false;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            match read_feed(&client, &cursor) {
                Ok(feed) => {
                    if cursor.epoch != feed.epoch || unsupported {
                        eprintln!("[notifications] Live feed connected");
                    }
                    unsupported = false;
                    for message in cursor.consume(feed) {
                        deliver_message(app, &message);
                    }
                }
                Err(error) if error.status() == Some(reqwest::StatusCode::NOT_FOUND) => {
                    if !unsupported {
                        eprintln!("[notifications] Attached bridge has no live feed; notifications unavailable until Quick owns an updated bridge.");
                    }
                    unsupported = true;
                    // Never restart somebody else's bridge to upgrade it.
                    std::thread::sleep(Duration::from_secs(28));
                }
                Err(_) => {} // Booting/offline bridge: keep cursor and retry next poll.
            }
        }
    }

    fn read_feed(
        client: &reqwest::blocking::Client,
        cursor: &Cursor,
    ) -> Result<Feed, reqwest::Error> {
        client
            .get("http://127.0.0.1:8787/notification-events")
            .query(&[
                ("epoch", cursor.epoch.clone()),
                ("after", cursor.after.to_string()),
            ])
            .send()?
            .error_for_status()?
            .json()
    }

    fn deliver_message(app: &AppHandle, message: &IncomingMessage) {
        let selected = app
            .state::<crate::NotificationState>()
            .active_chat
            .lock()
            .unwrap()
            .clone();
        let visible = if crate::is_shown(app) {
            selected.as_deref()
        } else {
            None
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        if should_notify(message, now, visible) {
            send(
                &message.id,
                &message.chat_id,
                &message.title,
                &message.subtitle,
                &message.body,
            );
        }
    }

    pub fn add_menu_items(
        app: &AppHandle,
        menu: &tauri::menu::Menu<tauri::Wry>,
    ) -> tauri::Result<()> {
        use tauri::menu::MenuItem;
        menu.append(&MenuItem::with_id(
            app,
            "test-notification",
            "Test macOS Notification",
            true,
            None::<&str>,
        )?)?;
        menu.append(&MenuItem::with_id(
            app,
            "notification-settings",
            "Notification Settings…",
            true,
            None::<&str>,
        )?)
    }

    pub fn menu_event(_app: &AppHandle, id: &str) {
        match id {
            "test-notification" => request_permission(true),
            "notification-settings" => {
                if let Err(error) = std::process::Command::new("open")
                    .arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
                    .spawn()
                {
                    eprintln!("[notifications] Could not open settings: {error}");
                }
            }
            _ => {}
        }
    }

    pub fn request_permission(test: bool) {
        let completion = RcBlock::new(move |granted: objc2::runtime::Bool, error: *mut NSError| {
            if let Some(error) = unsafe { error.as_ref() } {
                eprintln!("[notifications] Authorization error: {} (domain={}, code={})", error, error.domain(), error.code());
            }
            eprintln!("[notifications] Permission granted={}", granted.as_bool());
            if granted.as_bool() && test {
                send(
                    "quick-test",
                    "",
                    "WhatsApp Quick",
                    "",
                    "Native macOS notifications are working.",
                );
                verify_test_delivery();
            }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &completion,
            );
    }

    fn verify_test_delivery() {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(2));
            let completion = RcBlock::new(
                |notifications: std::ptr::NonNull<objc2_foundation::NSArray<UNNotification>>| {
                    let delivered = unsafe { notifications.as_ref() }
                        .iter()
                        .any(|notification| {
                            notification.request().identifier().to_string() == "quick-test"
                        });
                    eprintln!("[notifications] Test present in Notification Center={delivered}");
                },
            );
            UNUserNotificationCenter::currentNotificationCenter()
                .getDeliveredNotificationsWithCompletionHandler(&completion);
        });
    }

    fn send(id: &str, chat_id: &str, title: &str, subtitle: &str, body: &str) {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setSubtitle(&NSString::from_str(subtitle));
        content.setBody(&NSString::from_str(body));
        content.setThreadIdentifier(&NSString::from_str(chat_id));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(id),
            &content,
            None,
        );
        let id = id.to_owned();
        let completion = RcBlock::new(move |error: *mut NSError| {
            if let Some(error) = unsafe { error.as_ref() } {
                eprintln!("[notifications] Delivery failed: {error}");
            } else {
                eprintln!("[notifications] Submitted id={id}");
            }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, Some(&completion));
    }
}

#[cfg(target_os = "macos")]
pub use native::{add_menu_items, menu_event, start};

#[cfg(test)]
mod tests {
    use super::*;
    fn feed(epoch: &str, sequence: u64) -> Feed {
        Feed {
            epoch: epoch.into(),
            cursor: sequence,
            events: vec![IncomingMessage {
                sequence,
                id: "message-1".into(),
                chat_id: "123@c.us".into(),
                timestamp: 1000.0,
                title: "Contact".into(),
                subtitle: String::new(),
                body: "Hello".into(),
            }],
        }
    }
    #[test]
    fn baseline_restart_and_duplicate_polls_do_not_replay() {
        let mut cursor = Cursor::default();
        assert!(cursor.consume(feed("a", 1)).is_empty());
        assert_eq!(cursor.consume(feed("a", 2)).len(), 1);
        assert!(cursor.consume(feed("a", 2)).is_empty());
        assert!(cursor.consume(feed("b", 1)).is_empty());
        assert_eq!(cursor.consume(feed("b", 2)).len(), 1);
    }
    #[test]
    fn stale_messages_and_visible_chat_are_suppressed() {
        let message = feed("a", 1).events.remove(0);
        assert!(should_notify(&message, 1001.0, None));
        assert!(should_notify(&message, 1001.0, Some("other@g.us")));
        assert!(!should_notify(&message, 1001.0, Some("123@c.us")));
        assert!(!should_notify(&message, 1121.0, None));
        assert!(!should_notify(&message, 999.0, None));
    }
    #[test]
    fn only_whatsapp_chat_ids_can_be_opened() {
        for id in ["123@c.us", "123-456@g.us", "123@lid"] {
            assert!(valid_chat_id(id));
        }
        for id in [
            "@c.us",
            "status@broadcast",
            "../file@c.us",
            "123@evil",
            "1@c.us@lid",
        ] {
            assert!(!valid_chat_id(id));
        }
    }
}

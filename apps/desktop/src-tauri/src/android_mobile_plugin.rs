use tauri::{
    plugin::{Builder, TauriPlugin},
    Wry,
};

#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;

#[cfg(target_os = "android")]
pub struct AndroidRuntimePluginHandle(pub PluginHandle<Wry>);

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("chordv_android_runtime")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin(
                    "com.baymaxgroup.chordv",
                    "ChordvAndroidRuntimePlugin",
                )?;
                _app.manage(AndroidRuntimePluginHandle(handle));
            }

            Ok(())
        })
        .build()
}

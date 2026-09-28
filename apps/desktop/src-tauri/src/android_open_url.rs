//! 安卓端用系统默认应用（通常是浏览器）打开 http/https 链接：通过 JNI 发送 ACTION_VIEW Intent。
//! 调用方（open_external_url_blocking）已校验协议只能是 http/https。
//! Activity 与 JavaVM 来自 tao 初始化的 ndk_context（与 tao 读取屏幕尺寸的方式相同）。
use jni::objects::{JObject, JValue};
use jni::JavaVM;

const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;
const UNAVAILABLE: &str = "安卓端暂时无法打开外部链接，请稍后重试。";

pub fn open(url: &str) -> Result<(), String> {
    let context = ndk_context::android_context();
    if context.vm().is_null() || context.context().is_null() {
        return Err(UNAVAILABLE.into());
    }
    // SAFETY: tao 在创建 Activity 时用有效的 JavaVM 与 Activity 全局引用初始化了 ndk_context，
    // 应用运行期间一直有效；这里只借用，不释放。
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }.map_err(|_| UNAVAILABLE.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|_| UNAVAILABLE.to_string())?;
    let activity = unsafe { JObject::from_raw(context.context().cast()) };
    let result = env.with_local_frame(16, |env| -> jni::errors::Result<()> {
        let url = env.new_string(url)?;
        let uri = env
            .call_static_method(
                "android/net/Uri",
                "parse",
                "(Ljava/lang/String;)Landroid/net/Uri;",
                &[JValue::Object(&url)],
            )?
            .l()?;
        let action = env.new_string("android.intent.action.VIEW")?;
        let intent = env.new_object(
            "android/content/Intent",
            "(Ljava/lang/String;Landroid/net/Uri;)V",
            &[JValue::Object(&action), JValue::Object(&uri)],
        )?;
        env.call_method(&intent, "addFlags", "(I)Landroid/content/Intent;", &[JValue::Int(FLAG_ACTIVITY_NEW_TASK)])?;
        env.call_method(&activity, "startActivity", "(Landroid/content/Intent;)V", &[JValue::Object(&intent)])?;
        Ok(())
    });
    if result.is_err() {
        // 例如没有可以打开链接的应用（ActivityNotFoundException）：清掉 Java 异常，返回中文提示。
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        return Err("没有找到可以打开链接的应用，请安装浏览器后重试。".into());
    }
    Ok(())
}

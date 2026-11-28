const status = document.getElementById("status");
const portal = document.getElementById("portal");
const buttons = [...document.querySelectorAll("button")];

async function request(route, payload) {
  const response = await fetch(route, {
    method: payload === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.code ?? "REQUEST_FAILED");
  return result.data;
}

function nativeMessage(message) {
  if (!window.AchordConnectNative?.postMessage) throw new Error("原生工单桥未连接");
  window.AchordConnectNative.postMessage(JSON.stringify({ source: "achord-connect-v1", ...message }));
}

async function send(type, unreadCount) {
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const message = { type, ...(unreadCount === undefined ? {} : { unreadCount }) };
    await request("/api/session/bridge", message);
    nativeMessage(message);
    if (unreadCount !== undefined) document.getElementById("unread").textContent = String(unreadCount);
    if (type === "session-expired") {
      portal.hidden = true;
      status.textContent = "工单会话已结束，请从客户端重新打开。";
    }
  } catch (error) { status.textContent = `操作失败：${error.message}`; }
  finally { buttons.forEach((button) => { button.disabled = false; }); }
}

async function start() {
  const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket");
  history.replaceState(null, "", "/portal");
  try {
    const session = ticket ? await request("/api/session/redeem", { ticket }) : await request("/api/session");
    document.getElementById("contact").textContent = session.user.name || "本地测试用户";
    document.getElementById("unread").textContent = String(session.unreadCount);
    await request("/api/session/bridge", { type: "ready" });
    nativeMessage({ type: "ready" });
    portal.hidden = false;
    status.textContent = "工单会话已建立，原生消息桥已就绪。";
  } catch (error) { status.textContent = `打开失败：${error.message}`; }
}

document.getElementById("unread-seven").addEventListener("click", () => send("unread-changed", 7));
document.getElementById("unread-zero").addEventListener("click", () => send("unread-changed", 0));
document.getElementById("delay-next-launch").addEventListener("click", async () => {
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await request("/api/session/next-launch-delay", {});
    status.textContent = `已安排下次打开延迟 ${result.delayMs / 1000} 秒。关闭此窗口后，从客户端重新打开。`;
  } catch (error) { status.textContent = `设置失败：${error.message}`; }
  finally { buttons.forEach((button) => { button.disabled = false; }); }
});
document.getElementById("expire-session").addEventListener("click", () => send("session-expired"));
document.getElementById("close-window").addEventListener("click", () => send("close-requested"));
void start();

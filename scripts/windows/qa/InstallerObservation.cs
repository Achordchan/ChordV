using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace ChordVInstallerQA {
    // Read-only event observation. No injection, clicks, SendMessage, proxy
    // writes or replacement app. Parsed command lines are not app receipts.
    public sealed class Observer : IDisposable {
        public sealed class WindowRecord {
            public uint ProcessId;
            public string Title;
            public bool InstallProgress;
            public bool DirectoryEditor;
            public string[] Controls;
        }
        public sealed class AppRecord { public int ProcessId; public string Executable; }
        readonly string root;
        readonly ConcurrentDictionary<uint, bool> installers = new ConcurrentDictionary<uint, bool>();
        readonly ConcurrentQueue<WindowRecord> windows = new ConcurrentQueue<WindowRecord>();
        readonly ConcurrentQueue<AppRecord> apps = new ConcurrentQueue<AppRecord>();
        readonly ConcurrentDictionary<int, bool> appIds = new ConcurrentDictionary<int, bool>();
        readonly ManualResetEventSlim ready = new ManualResetEventSlim(false);
        readonly ManualResetEventSlim app = new ManualResetEventSlim(false);
        readonly Thread thread;
        readonly WinEvent callback;
        uint threadId;
        IntPtr hook;
        Exception error;
        public Observer(string applicationRoot) {
            root = Path.GetFullPath(applicationRoot).TrimEnd('\\') + "\\";
            callback = OnEvent;
            thread = new Thread(Loop) { IsBackground = true };
            thread.Start();
            if (!ready.Wait(10000) || error != null) throw new InvalidOperationException("WinEvent observer unavailable", error);
        }
        public void ObserveInstaller(int pid) { installers[(uint)pid] = true; }
        public bool WaitForApp(int milliseconds) { return app.Wait(milliseconds); }
        public WindowRecord[] Windows() { return windows.ToArray(); }
        public AppRecord[] Apps() { return apps.ToArray(); }
        void Loop() {
            try {
                threadId = GetCurrentThreadId();
                Message message;
                PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
                hook = SetWinEventHook(0x8002, 0x8002, IntPtr.Zero, callback, 0, 0, 0);
                if (hook == IntPtr.Zero) throw new InvalidOperationException("SetWinEventHook failed");
                ready.Set();
                while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }
            } catch (Exception exception) { error = exception; ready.Set(); }
            finally { if (hook != IntPtr.Zero) UnhookWinEvent(hook); }
        }
        void OnEvent(IntPtr handle, uint eventId, IntPtr hwnd, int objectId, int childId, uint eventThread, uint time) {
            if (hwnd == IntPtr.Zero) return;
            try {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (installers.ContainsKey(pid)) {
                    var top = GetAncestor(hwnd, 2);
                    var controls = new List<string>();
                    bool progress = false, directory = false, details = false;
                    EnumChildWindows(top, (child, ignored) => {
                        if (!IsWindowVisible(child)) return true;
                        string name = Class(child);
                        int id = GetDlgCtrlID(child);
                        controls.Add(id + ":" + name + ":" + Text(child));
                        if (name.Equals("msctls_progress32", StringComparison.OrdinalIgnoreCase) && id == 1004) progress = true;
                        if (id == 1027) details = true;
                        if (name.Equals("Edit", StringComparison.OrdinalIgnoreCase) && id == 1019) directory = true;
                        return true;
                    }, IntPtr.Zero);
                    windows.Enqueue(new WindowRecord { ProcessId = pid, Title = Text(top), InstallProgress = progress && details, DirectoryEditor = directory, Controls = controls.ToArray() });
                    return;
                }
                using (var process = Process.GetProcessById((int)pid)) {
                    var executable = process.MainModule.FileName;
                    if (!executable.StartsWith(root, StringComparison.OrdinalIgnoreCase)
                        || !new[] { "ChordV.exe", "chordv-desktop.exe", "chordv_desktop.exe" }.Contains(Path.GetFileName(executable), StringComparer.OrdinalIgnoreCase)) return;
                    if (appIds.TryAdd(process.Id, true)) {
                        apps.Enqueue(new AppRecord { ProcessId = process.Id, Executable = executable });
                        app.Set();
                    }
                }
            } catch { /* A disappearing or inaccessible window is not a successful observation. */ }
        }
        static string Class(IntPtr hwnd) { var text = new StringBuilder(256); GetClassName(hwnd, text, text.Capacity); return text.ToString(); }
        static string Text(IntPtr hwnd) { var text = new StringBuilder(1024); GetWindowText(hwnd, text, text.Capacity); return text.ToString(); }
        public static string[] ParseCommandLine(string command) {
            int count;
            IntPtr block = CommandLineToArgvW(command, out count);
            if (block == IntPtr.Zero) throw new InvalidOperationException("CommandLineToArgvW failed");
            try {
                var args = new string[count];
                for (int i = 0; i < count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(block, i * IntPtr.Size));
                return args;
            } finally { LocalFree(block); }
        }
        public void Dispose() { if (threadId != 0) PostThreadMessage(threadId, 0x12, UIntPtr.Zero, IntPtr.Zero); thread.Join(10000); ready.Dispose(); app.Dispose(); }
        delegate void WinEvent(IntPtr hook, uint evt, IntPtr hwnd, int obj, int child, uint thread, uint time);
        delegate bool EnumChild(IntPtr hwnd, IntPtr data);
        [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr Hwnd; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public int X, Y; public uint Private; }
        [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEvent callback, uint pid, uint thread, uint flags);
        [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")] static extern int GetMessage(out Message msg, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] static extern bool PeekMessage(out Message msg, IntPtr hwnd, uint min, uint max, uint remove);
        [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message msg);
        [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message msg);
        [DllImport("user32.dll")] static extern bool PostThreadMessage(uint id, uint msg, UIntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumChild callback, IntPtr data);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command, out int count);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr block);
    }
}

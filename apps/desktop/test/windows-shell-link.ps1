# Use the documented Unicode IShellLinkW interface for real .lnk fixtures.
# This avoids the legacy WScript automation layer's TargetPath conversion.
if ('ChordVShortcutFixture' -as [type]) { return }
Add-Type @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
internal class ChordVShellLink { }
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IChordVShellLinkW {
 void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size, IntPtr findData, uint flags);
 void GetIDList(out IntPtr list);
 void SetIDList(IntPtr list);
 void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int size);
 void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
 void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int size);
 void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string text);
 void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int size);
 void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string text);
 void GetHotkey(out short key);
 void SetHotkey(short key);
 void GetShowCmd(out int command);
 void SetShowCmd(int command);
 void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int size, out int index);
 void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string text, int index);
 void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string text, uint reserved);
 void Resolve(IntPtr window, uint flags);
 void SetPath([MarshalAs(UnmanagedType.LPWStr)] string text);
}
public static class ChordVShortcutFixture {
 public static void Create(string linkPath, string target, string directory) {
  object instance = new ChordVShellLink();
  try {
   var link = (IChordVShellLinkW)instance;
   link.SetPath(Path.GetFullPath(target));
   link.SetWorkingDirectory(Path.GetFullPath(directory));
   ((IPersistFile)instance).Save(Path.GetFullPath(linkPath), true);
  } finally { Marshal.FinalReleaseComObject(instance); }
 }
 public static string ReadTarget(string linkPath) {
  object instance = new ChordVShellLink();
  try {
   ((IPersistFile)instance).Load(Path.GetFullPath(linkPath), 0);
   var text = new StringBuilder(32768);
   ((IChordVShellLinkW)instance).GetPath(text, text.Capacity, IntPtr.Zero, 4);
   return text.ToString();
  } finally { Marshal.FinalReleaseComObject(instance); }
 }
}
'@

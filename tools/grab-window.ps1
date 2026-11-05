# Capture the DeepSeek Harness window even while it is occluded.
#
# `CopyFromScreen` reads the desktop, so any window on top wins. Chromium (and
# therefore Electron) only paints into `PrintWindow` when the caller passes
# PW_RENDERFULLCONTENT (0x00000002); without it the result is a blank bitmap,
# which is why an earlier attempt captured nothing. This asks the window to
# render itself into a DC instead of reading pixels off the screen.
param(
  [string]$Title = 'DeepSeek Harness',
  [string]$Out = (Join-Path $PSScriptRoot '.tmp-win.png')
)

Add-Type -AssemblyName System.Drawing
# A here-string Add-Type does not inherit the loaded System.Drawing assembly;
# without the explicit reference every Bitmap/Graphics use fails to compile.
Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public struct RECT { public int Left, Top, Right, Bottom; }

public class DshGrab {
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);

  public static string Dump() {
    var text = new StringBuilder();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      RECT r;
      GetWindowRect(h, out r);
      text.AppendLine(string.Format("{0} | {1}x{2} at {3},{4} | iconic={5} | {6}",
        h, r.Right - r.Left, r.Bottom - r.Top, r.Left, r.Top, IsIconic(h), sb.ToString()));
      return true;
    }, IntPtr.Zero);
    return text.ToString();
  }

  public static IntPtr Find(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      if (sb.ToString().Contains(needle)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static IntPtr FindLargest(string needle) {
    IntPtr found = IntPtr.Zero;
    long best = 0;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      if (!sb.ToString().Contains(needle)) return true;
      RECT r;
      GetWindowRect(h, out r);
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > best) { best = area; found = h; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool Grab(IntPtr h, string path) {
    RECT r;
    if (!GetWindowRect(h, out r)) return false;
    int w = r.Right - r.Left;
    int ht = r.Bottom - r.Top;
    if (w <= 0 || ht <= 0) return false;
    using (var bmp = new System.Drawing.Bitmap(w, ht))
    using (var g = System.Drawing.Graphics.FromImage(bmp)) {
      IntPtr dc = g.GetHdc();
      // 0x00000002 = PW_RENDERFULLCONTENT, required by Chromium-backed windows.
      bool ok = PrintWindow(h, dc, 0x00000002);
      g.ReleaseHdc(dc);
      if (!ok) return false;
      bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
    }
    return true;
  }
}
"@

"=== visible windows ==="
[DshGrab]::Dump()

$hwnd = [DshGrab]::FindLargest($Title)
if ($hwnd -eq [IntPtr]::Zero) { 'window not found'; exit 1 }
"target=$hwnd"
"grabbed=$([DshGrab]::Grab($hwnd, $Out))"
"saved $Out"

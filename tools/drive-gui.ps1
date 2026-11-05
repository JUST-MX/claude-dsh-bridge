# Drive the DeepSeek Harness window: raise it, click a point, capture the screen.
# Everything runs in one process because a PowerShell Add-Type is per-runspace.
param(
  [int[]]$Click = @(),
  [string]$Out = (Join-Path $PSScriptRoot '.tmp-shot.png'),
  [int]$Wait = 1500
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class DshWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(int attach, int to, bool join);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();

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

  public static bool Topmost(IntPtr h, bool on) {
    return SetWindowPos(h, new IntPtr(on ? -1 : -2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
  }

  public static bool Raise(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    ShowWindow(h, 9);
    int pid;
    int fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    int mine = GetCurrentThreadId();
    bool joined = fgThread != mine && AttachThreadInput(mine, fgThread, true);
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    SetFocus(h);
    if (joined) AttachThreadInput(mine, fgThread, false);
    return ok;
  }

  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(80);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }
}
"@

$hwnd = [DshWin]::Find('DeepSeek Harness')
if ($hwnd -eq [IntPtr]::Zero) { 'window not found'; exit 1 }
"hwnd=$hwnd"

if ($Click.Count -ge 2) {
  "raised=$([DshWin]::Raise($hwnd))"
  Start-Sleep -Milliseconds 600
  "foreground=$([DshWin]::GetForegroundWindow())"
  for ($i = 0; $i -lt $Click.Count; $i += 2) {
    "click $($Click[$i]),$($Click[$i + 1])"
    [DshWin]::Click($Click[$i], $Click[$i + 1])
    Start-Sleep -Milliseconds $Wait
  }
}

$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"saved $Out"

# Long-running helper for Family Photos. Talks to Windows on Node's behalf.
# Reads one request per line on stdin, writes one reply line on stdout.
#   A<TAB>path1<TAB>path2...                 -> file attributes, comma separated (-1 = error)
#   T<TAB>size<TAB>flags<TAB>path<TAB>out    -> "ok" or "err <hresult>"; saves a PNG thumbnail
# Neither request reads the photo itself, so cloud-only files (OneDrive/iCloud) are NOT downloaded:
# the thumbnail comes from Windows' thumbnail cache or the sync app, just like in File Explorer.

$ErrorActionPreference = 'Stop'
# A stale LIB variable (left by old Visual Studio installs) makes the C# compiler fail; it isn't needed.
$env:LIB = $null
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class FpShell {
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItemImageFactory {
    [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm);
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct SIZE { public int cx; public int cy; }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
  static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IntPtr ppv);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);

  public static string Attrs(string[] paths) {
    var parts = new string[paths.Length];
    for (int i = 0; i < paths.Length; i++) {
      try { parts[i] = ((int)File.GetAttributes(paths[i])).ToString(); } catch { parts[i] = "-1"; }
    }
    return string.Join(",", parts);
  }

  // flags: SIIGBF_BIGGERSIZEOK=0x1, SIIGBF_THUMBNAILONLY=0x8, SIIGBF_INCACHEONLY=0x10
  public static string Thumb(string path, int size, int flags, string outPath) {
    Guid iid = typeof(IShellItemImageFactory).GUID;
    IntPtr p;
    int hr = SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out p);
    if (hr != 0) return "err " + hr.ToString("X8");
    var f = (IShellItemImageFactory)Marshal.GetObjectForIUnknown(p);
    Marshal.Release(p);
    IntPtr hbm = IntPtr.Zero;
    try {
      hr = f.GetImage(new SIZE { cx = size, cy = size }, flags, out hbm);
      if (hr != 0 || hbm == IntPtr.Zero) return "err " + hr.ToString("X8");
      using (var bmp = Image.FromHbitmap(hbm)) bmp.Save(outPath, ImageFormat.Png);
      return "ok";
    } catch (Exception e) {
      return "err " + e.Message.Replace("\r", " ").Replace("\n", " ");
    } finally {
      if (hbm != IntPtr.Zero) DeleteObject(hbm);
      Marshal.ReleaseComObject(f);
    }
  }
}
'@

[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$out = [Console]::Out
$out.WriteLine('ready')
$out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Split("`t")
  try {
    switch ($parts[0]) {
      'A' { $reply = [FpShell]::Attrs($parts[1..($parts.Length - 1)]) }
      'T' { $reply = [FpShell]::Thumb($parts[3], [int]$parts[1], [int]$parts[2], $parts[4]) }
      default { $reply = 'err unknown' }
    }
  } catch {
    $reply = 'err ' + ($_.Exception.Message -replace '[\r\n]', ' ')
  }
  $out.WriteLine($reply)
  $out.Flush()
}

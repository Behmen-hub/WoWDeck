using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace WoWDeckNative
{
    internal static class Program
    {
        // ====================================================================
        // Win32 P/Invoke Declarations (user32.dll & gdi32.dll)
        // ====================================================================

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        private static extern IntPtr GetDesktopWindow();

        [DllImport("user32.dll")]
        private static extern IntPtr GetWindowDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int nWidth, int nHeight);

        [DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);

        [DllImport("gdi32.dll")]
        private static extern bool BitBlt(
            IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight,
            IntPtr hdcSrc, int nXSrc, int nYSrc, int dwRop);

        [DllImport("gdi32.dll")]
        private static extern int GetDIBits(
            IntPtr hdc, IntPtr hbmp, uint uStartScan, uint cScanLines,
            [Out] byte[] lpvBits, ref BITMAPINFO lpbi, uint uUsage);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr hObject);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteDC(IntPtr hdc);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        private static extern uint MapVirtualKey(uint uCode, uint uMapType);

        private const int SRCCOPY = 0x00CC0020;
        private const uint DIB_RGB_COLORS = 0;

        private const int INPUT_KEYBOARD = 1;
        private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        private const uint KEYEVENTF_KEYUP = 0x0002;

        // Explicit Left Modifier VK codes required by WoW raw/hardware input
        private const ushort VK_LSHIFT = 0xA0;
        private const ushort VK_LCONTROL = 0xA2;
        private const ushort VK_LMENU = 0xA4; // Left ALT

        // 41 Base Keys for Candidate Key Pool (1..164)
        private static readonly ushort[] BASE_KEYS_41_VK = new ushort[]
        {
            0x31, // 1: "1"
            0x32, // 2: "2"
            0x33, // 3: "3"
            0x34, // 4: "4"
            0x35, // 5: "5"
            0x36, // 6: "6"
            0x37, // 7: "7"
            0x38, // 8: "8"
            0x39, // 9: "9"
            0x6A, // 10: "NUMPADMULTIPLY"
            0x6B, // 11: "NUMPADPLUS"
            0x6D, // 12: "NUMPADMINUS"
            0x6F, // 13: "NUMPADDIVIDE" (extended)
            0x2D, // 14: "INSERT" (extended)
            0x2E, // 15: "DELETE" (extended)
            0x24, // 16: "HOME" (extended)
            0x23, // 17: "END" (extended)
            0x21, // 18: "PAGEUP" (extended)
            0x22, // 19: "PAGEDOWN" (extended)
            0x08, // 20: "BACKSPACE"
            0x26, // 21: "UP" (extended)
            0x28, // 22: "DOWN" (extended)
            0x25, // 23: "LEFT" (extended)
            0x27, // 24: "RIGHT" (extended)
            0x42, // 25: "B"
            0x43, // 26: "C"
            0x46, // 27: "F"
            0x47, // 28: "G"
            0x48, // 29: "H"
            0x49, // 30: "I"
            0x4A, // 31: "J"
            0x4B, // 32: "K"
            0x4C, // 33: "L"
            0x4D, // 34: "M"
            0x4E, // 35: "N"
            0x4F, // 36: "O"
            0x50, // 37: "P"
            0x54, // 38: "T"
            0x55, // 39: "U"
            0x56, // 40: "V"
            0x58  // 41: "X"
        };

        // 10 Numpad Digits for Candidate Key Pool (165..174 with CTRL-)
        private static readonly ushort[] NUMPAD_DIGITS_10_VK = new ushort[]
        {
            0x60, // "NUMPAD0"
            0x61, // "NUMPAD1"
            0x62, // "NUMPAD2"
            0x63, // "NUMPAD3"
            0x64, // "NUMPAD4"
            0x65, // "NUMPAD5"
            0x66, // "NUMPAD6"
            0x67, // "NUMPAD7"
            0x68, // "NUMPAD8"
            0x69  // "NUMPAD9"
        };

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BITMAPINFOHEADER
        {
            public uint biSize;
            public int biWidth;
            public int biHeight;
            public ushort biPlanes;
            public ushort biBitCount;
            public uint biCompression;
            public uint biSizeImage;
            public int biXPelsPerMeter;
            public int biYPelsPerMeter;
            public uint biClrUsed;
            public uint biClrImportant;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BITMAPINFO
        {
            public BITMAPINFOHEADER bmiHeader;
            public uint bmiColors;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public int type;
            public InputUnion u;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion
        {
            [FieldOffset(0)]
            public MOUSEINPUT mi;
            [FieldOffset(0)]
            public KEYBDINPUT ki;
            [FieldOffset(0)]
            public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        private static int _cachedWidth = 0;
        private static int _cachedHeight = 0;
        private static byte[] _pixelBuffer = null;

        private static void Main(string[] args)
        {
            try
            {
                SetProcessDPIAware();
            }
            catch
            {
            }

            Console.InputEncoding = Encoding.UTF8;
            Console.OutputEncoding = Encoding.UTF8;

            string line;
            while ((line = Console.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;

                try
                {
                    if (line.StartsWith("SEND_POOL_KEY", StringComparison.OrdinalIgnoreCase))
                    {
                        string[] parts = line.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                        int poolIdx = parts.Length > 1 ? int.Parse(parts[1]) : 1;
                        EnsureWoWWindowFocused();
                        ushort vk;
                        bool ctrl, alt, shift;
                        ResolvePoolIndexBinding(poolIdx, out vk, out ctrl, out alt, out shift);
                        SendStagedKeyCombo(vk, ctrl, alt, shift);
                        Console.WriteLine("{\"ok\":true,\"poolIndex\":" + poolIdx + ",\"vkCode\":" + vk + "}");
                    }
                    else if (line.Contains("\"capture\""))
                    {
                        int width = ExtractInt(line, "width", 320);
                        int height = ExtractInt(line, "height", 24);
                        HandleCapture(width, height);
                    }
                    else if (line.Contains("\"sendKey\""))
                    {
                        int poolIndex = ExtractInt(line, "poolIndex", 0);
                        int slot = ExtractInt(line, "slot", 0);
                        int explicitVk = ExtractInt(line, "vkCode", 0);
                        if (explicitVk > 0)
                        {
                            bool ctrl = ExtractBool(line, "ctrl", false);
                            bool alt = ExtractBool(line, "alt", false);
                            bool shift = ExtractBool(line, "shift", false);
                            EnsureWoWWindowFocused();
                            SendStagedKeyCombo((ushort)explicitVk, ctrl, alt, shift);
                            int reportedIndex = poolIndex > 0 ? poolIndex : slot;
                            Console.WriteLine("{\"ok\":true,\"slot\":" + reportedIndex + ",\"poolIndex\":" + reportedIndex + ",\"vkCode\":" + explicitVk + "}");
                        }
                        else if (poolIndex >= 1 && poolIndex <= 174)
                        {
                            EnsureWoWWindowFocused();
                            ushort vk;
                            bool ctrl, alt, shift;
                            ResolvePoolIndexBinding(poolIndex, out vk, out ctrl, out alt, out shift);
                            SendStagedKeyCombo(vk, ctrl, alt, shift);
                            Console.WriteLine("{\"ok\":true,\"slot\":" + poolIndex + ",\"poolIndex\":" + poolIndex + ",\"vkCode\":" + vk + "}");
                        }
                        else if (slot >= 1 && slot <= 174)
                        {
                            EnsureWoWWindowFocused();
                            ushort vk;
                            bool ctrl, alt, shift;
                            ResolvePoolIndexBinding(slot, out vk, out ctrl, out alt, out shift);
                            SendStagedKeyCombo(vk, ctrl, alt, shift);
                            Console.WriteLine("{\"ok\":true,\"slot\":" + slot + ",\"poolIndex\":" + slot + ",\"vkCode\":" + vk + "}");
                        }
                        else
                        {
                            Console.WriteLine("{\"ok\":false,\"error\":\"Invalid poolIndex, slot or vkCode\"}");
                        }
                    }
                    else if (line.Contains("\"ping\""))
                    {
                        Console.WriteLine("{\"ok\":true,\"pong\":true}");
                    }
                    else if (line.Contains("\"exit\""))
                    {
                        break;
                    }
                    else
                    {
                        Console.WriteLine("{\"ok\":false,\"error\":\"Unknown command\"}");
                    }
                }
                catch (Exception ex)
                {
                    string safeMsg = ex.Message.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ");
                    Console.WriteLine("{\"ok\":false,\"error\":\"" + safeMsg + "\"}");
                }
            }
        }

        private static IntPtr FindWoWWindow()
        {
            IntPtr hwnd = FindWindow("GxWindowClass", null);
            if (hwnd != IntPtr.Zero && IsWindowVisible(hwnd) && !IsIconic(hwnd))
            {
                return hwnd;
            }
            hwnd = FindWindow(null, "World of Warcraft");
            if (hwnd != IntPtr.Zero && IsWindowVisible(hwnd) && !IsIconic(hwnd))
            {
                return hwnd;
            }

            try
            {
                string[] procNames = new string[] { "Wow", "WowClassic", "WowForever", "Wow-64" };
                foreach (string name in procNames)
                {
                    Process[] procs = Process.GetProcessesByName(name);
                    foreach (Process p in procs)
                    {
                        if (p.MainWindowHandle != IntPtr.Zero && IsWindowVisible(p.MainWindowHandle) && !IsIconic(p.MainWindowHandle))
                        {
                            return p.MainWindowHandle;
                        }
                    }
                }
            }
            catch
            {
            }

            return IntPtr.Zero;
        }

        private static void EnsureWoWWindowFocused()
        {
            IntPtr wowHwnd = FindWoWWindow();
            if (wowHwnd != IntPtr.Zero)
            {
                IntPtr fg = GetForegroundWindow();
                if (fg != wowHwnd)
                {
                    SetForegroundWindow(wowHwnd);
                    Thread.Sleep(15);
                }
            }
        }

        private static void HandleCapture(int width, int height)
        {
            if (width < 234) width = 234;
            if (width > 800) width = 800;
            if (height < 1) height = 1;
            if (height > 200) height = 200;

            int originX = 0;
            int originY = 0;

            IntPtr wowHwnd = FindWoWWindow();
            if (wowHwnd != IntPtr.Zero)
            {
                POINT pt = new POINT { X = 0, Y = 0 };
                if (ClientToScreen(wowHwnd, ref pt))
                {
                    if (pt.X >= 0 && pt.Y >= 0)
                    {
                        originX = pt.X;
                        originY = pt.Y;
                    }
                }
            }

            IntPtr hDesktop = GetDesktopWindow();
            IntPtr hdcScreen = GetWindowDC(hDesktop);
            if (hdcScreen == IntPtr.Zero)
            {
                Console.WriteLine("{\"ok\":false,\"error\":\"GetWindowDC failed\"}");
                return;
            }

            IntPtr hdcMem = CreateCompatibleDC(hdcScreen);
            IntPtr hBitmap = CreateCompatibleBitmap(hdcScreen, width, height);
            IntPtr hOld = SelectObject(hdcMem, hBitmap);

            try
            {
                bool bltOk = BitBlt(hdcMem, 0, 0, width, height, hdcScreen, originX, originY, SRCCOPY);
                if (!bltOk)
                {
                    Console.WriteLine("{\"ok\":false,\"error\":\"BitBlt failed\"}");
                    return;
                }

                int bufferSize = width * height * 4;
                if (_pixelBuffer == null || _cachedWidth != width || _cachedHeight != height)
                {
                    _pixelBuffer = new byte[bufferSize];
                    _cachedWidth = width;
                    _cachedHeight = height;
                }

                BITMAPINFO bmi = new BITMAPINFO();
                bmi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
                bmi.bmiHeader.biWidth = width;
                bmi.bmiHeader.biHeight = -height; // Top-down DIB
                bmi.bmiHeader.biPlanes = 1;
                bmi.bmiHeader.biBitCount = 32;
                bmi.bmiHeader.biCompression = 0;

                int lines = GetDIBits(hdcMem, hBitmap, 0, (uint)height, _pixelBuffer, ref bmi, DIB_RGB_COLORS);
                if (lines == 0)
                {
                    Console.WriteLine("{\"ok\":false,\"error\":\"GetDIBits returned 0\"}");
                    return;
                }

                string b64 = Convert.ToBase64String(_pixelBuffer);
                Console.WriteLine(
                    "{\"ok\":true,\"width\":" + width +
                    ",\"height\":" + height +
                    ",\"originX\":" + originX +
                    ",\"originY\":" + originY +
                    ",\"bgraBase64\":\"" + b64 + "\"}");
            }
            finally
            {
                SelectObject(hdcMem, hOld);
                DeleteObject(hBitmap);
                DeleteDC(hdcMem);
                ReleaseDC(hDesktop, hdcScreen);
            }
        }

        public static void ResolvePoolIndexBinding(int poolIndex, out ushort vk, out bool ctrl, out bool alt, out bool shift)
        {
            if (poolIndex < 1) poolIndex = 1;
            if (poolIndex > 174) poolIndex = 174;

            // 1..41: CTRL-SHIFT + BASE_KEYS_41_VK[0..40]
            if (poolIndex <= 41)
            {
                vk = BASE_KEYS_41_VK[poolIndex - 1];
                ctrl = true;
                alt = false;
                shift = true;
                return;
            }

            // 42..82: ALT-SHIFT + BASE_KEYS_41_VK[0..40]
            if (poolIndex <= 82)
            {
                vk = BASE_KEYS_41_VK[poolIndex - 42];
                ctrl = false;
                alt = true;
                shift = true;
                return;
            }

            // 83..123: CTRL + BASE_KEYS_41_VK[0..40]
            if (poolIndex <= 123)
            {
                vk = BASE_KEYS_41_VK[poolIndex - 83];
                ctrl = true;
                alt = false;
                shift = false;
                return;
            }

            // 124..164: ALT + BASE_KEYS_41_VK[0..40]
            if (poolIndex <= 164)
            {
                vk = BASE_KEYS_41_VK[poolIndex - 124];
                ctrl = false;
                alt = true;
                shift = false;
                return;
            }

            // 165..174: CTRL + NUMPAD_DIGITS_10_VK[0..9]
            vk = NUMPAD_DIGITS_10_VK[poolIndex - 165];
            ctrl = true;
            alt = false;
            shift = false;
        }

        public static void ResolveSlotBinding(int slot, out ushort vk, out bool ctrl, out bool alt, out bool shift)
        {
            ResolvePoolIndexBinding(slot, out vk, out ctrl, out alt, out shift);
        }

        private static bool IsExtendedVirtualKey(ushort vk)
        {
            return vk == 0x6F || // NUMPADDIVIDE
                   vk == 0x2D || // INSERT
                   vk == 0x2E || // DELETE
                   vk == 0x24 || // HOME
                   vk == 0x23 || // END
                   vk == 0x21 || // PAGEUP
                   vk == 0x22 || // PAGEDOWN
                   vk == 0x26 || // UP
                   vk == 0x28 || // DOWN
                   vk == 0x25 || // LEFT
                   vk == 0x27;   // RIGHT
        }

        private static void SendStagedKeyCombo(ushort vkTarget, bool ctrl, bool alt, bool shift)
        {
            // Strictly prevent AltGr (CTRL + ALT) on German QWERTZ keyboards
            if (ctrl && alt)
            {
                alt = false;
            }

            // 1. Modifiers KeyDown -> Sleep(15)
            List<INPUT> modDown = new List<INPUT>(2);
            if (ctrl) modDown.Add(CreateKeyInput(VK_LCONTROL, false));
            if (alt) modDown.Add(CreateKeyInput(VK_LMENU, false));
            if (shift) modDown.Add(CreateKeyInput(VK_LSHIFT, false));

            if (modDown.Count > 0)
            {
                INPUT[] downArr = modDown.ToArray();
                SendInput((uint)downArr.Length, downArr, Marshal.SizeOf(typeof(INPUT)));
                Thread.Sleep(15);
            }

            // 2. Target KeyDown -> Sleep(30)
            INPUT[] keyDownArr = new INPUT[] { CreateKeyInput(vkTarget, false) };
            SendInput(1, keyDownArr, Marshal.SizeOf(typeof(INPUT)));
            Thread.Sleep(30);

            // 3. Target KeyUp -> Sleep(15)
            INPUT[] keyUpArr = new INPUT[] { CreateKeyInput(vkTarget, true) };
            SendInput(1, keyUpArr, Marshal.SizeOf(typeof(INPUT)));

            // 4. Modifiers KeyUp in reverse order
            if (modDown.Count > 0)
            {
                Thread.Sleep(15);
                List<INPUT> modUp = new List<INPUT>(2);
                if (shift) modUp.Add(CreateKeyInput(VK_LSHIFT, true));
                if (alt) modUp.Add(CreateKeyInput(VK_LMENU, true));
                if (ctrl) modUp.Add(CreateKeyInput(VK_LCONTROL, true));
                INPUT[] upArr = modUp.ToArray();
                SendInput((uint)upArr.Length, upArr, Marshal.SizeOf(typeof(INPUT)));
            }
        }

        private static INPUT CreateKeyInput(ushort vk, bool keyUp)
        {
            INPUT input = new INPUT();
            input.type = INPUT_KEYBOARD;
            input.u.ki.wVk = vk;
            input.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);

            uint flags = keyUp ? KEYEVENTF_KEYUP : 0;
            if (IsExtendedVirtualKey(vk))
            {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }

            input.u.ki.dwFlags = flags;
            input.u.ki.time = 0;
            input.u.ki.dwExtraInfo = IntPtr.Zero;
            return input;
        }

        private static int ExtractInt(string json, string key, int defaultValue)
        {
            Match m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(-?\\d+)");
            if (m.Success)
            {
                int val;
                if (int.TryParse(m.Groups[1].Value, out val))
                {
                    return val;
                }
            }
            return defaultValue;
        }

        private static bool ExtractBool(string json, string key, bool defaultValue)
        {
            Match m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(true|false)", RegexOptions.IgnoreCase);
            if (m.Success)
            {
                return string.Equals(m.Groups[1].Value, "true", StringComparison.OrdinalIgnoreCase);
            }
            return defaultValue;
        }
    }
}

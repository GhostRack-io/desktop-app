#!/usr/bin/env python3
"""Resize/close/reopen the packaged app on a disposable Linux X11 display.

python3 tests/window-state.py artifacts/packages/ghostrack_0.1.0_amd64.appimage
"""
import ctypes as c
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


Display, Window, UInt = c.c_void_p, c.c_ulong, c.c_uint
x = c.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes, x.XOpenDisplay.restype = [c.c_char_p], Display
x.XDefaultRootWindow.argtypes, x.XDefaultRootWindow.restype = [Display], Window
x.XQueryTree.argtypes = [Display, Window, c.POINTER(Window), c.POINTER(Window), c.POINTER(c.POINTER(Window)), c.POINTER(UInt)]
x.XFetchName.argtypes = [Display, Window, c.POINTER(c.c_char_p)]
x.XGetGeometry.argtypes = [Display, Window, c.POINTER(Window), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(UInt), c.POINTER(UInt), c.POINTER(UInt), c.POINTER(UInt)]
x.XResizeWindow.argtypes = [Display, Window, UInt, UInt]
x.XInternAtom.argtypes, x.XInternAtom.restype = [Display, c.c_char_p, c.c_int], Window
x.XFree.argtypes = [c.c_void_p]
x.XFlush.argtypes = [Display]
x.XCloseDisplay.argtypes = [Display]


class MessageData(c.Union):
    _fields_ = [('bytes', c.c_char * 20), ('shorts', c.c_short * 10), ('longs', c.c_long * 5)]


class ClientMessage(c.Structure):
    _fields_ = [('type', c.c_int), ('serial', c.c_ulong), ('send_event', c.c_int), ('display', Display), ('window', Window), ('message_type', Window), ('format', c.c_int), ('data', MessageData)]


class Event(c.Union):
    _fields_ = [('client', ClientMessage), ('padding', c.c_long * 24)]


x.XSendEvent.argtypes = [Display, Window, c.c_int, c.c_long, c.POINTER(Event)]


def find_window(display, window, depth=0):
    name = c.c_char_p()
    x.XFetchName(display, window, c.byref(name))
    found = name.value == b'GhostRack'
    if name:
        x.XFree(c.cast(name, c.c_void_p))
    # GTK also creates a tiny leader window with the application's title.
    if found and size(display, window)[0] > 100:
        return window
    if depth > 5:
        return None
    root, parent, children, count = Window(), Window(), c.POINTER(Window)(), UInt()
    if x.XQueryTree(display, window, c.byref(root), c.byref(parent), c.byref(children), c.byref(count)):
        ids = [children[i] for i in range(count.value)]
        if children:
            x.XFree(children)
        for child in ids:
            if found := find_window(display, child, depth + 1):
                return found
    return None


def size(display, window):
    root, left, top, width, height, border, depth = Window(), c.c_int(), c.c_int(), UInt(), UInt(), UInt(), UInt()
    assert x.XGetGeometry(display, window, c.byref(root), c.byref(left), c.byref(top), c.byref(width), c.byref(height), c.byref(border), c.byref(depth))
    return width.value, height.value


def wait_for(predicate, process):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        assert process.poll() is None, 'App exited before the window was ready'
        if value := predicate():
            return value
        time.sleep(0.05)
    raise AssertionError('Window did not reach the expected size')


def close(display, window, process):
    event = Event()
    event.client.type, event.client.send_event = 33, 1
    event.client.display, event.client.window = display, window
    event.client.message_type = x.XInternAtom(display, b'WM_PROTOCOLS', 0)
    event.client.format = 32
    event.client.data.longs[0] = x.XInternAtom(display, b'WM_DELETE_WINDOW', 0)
    assert x.XSendEvent(display, window, 0, 0, c.byref(event))
    x.XFlush(display)
    assert process.wait(timeout=20) == 0, 'App did not close cleanly'


def main():
    executable = str(Path(sys.argv[1]).resolve())
    display = x.XOpenDisplay(None)
    assert display, 'Run with an isolated X11 DISPLAY (for example, Xvfb)'
    process = None
    try:
        with tempfile.TemporaryDirectory(prefix='ghostrack-window-state-') as directory:
            home = Path(directory)
            env = dict(os.environ, HOME=directory, XDG_CONFIG_HOME=str(home/'config'), XDG_STATE_HOME=str(home/'state'), XDG_DATA_HOME=str(home/'data'), MMX_HOME=str(home/'wallets'), APPIMAGE_EXTRACT_AND_RUN='1', WEBKIT_DISABLE_DMABUF_RENDERER='1')
            for key in ['GHOST_SEED_FILE', 'GHOST_RECOVERY_SEED_FILE']:
                env.pop(key, None)
            cache = home/'config/io.ghostrack.desktop/.window-state.json'
            steps = [((1440, 1000), (1210, 840)), ((1210, 840), (1080, 720)), ((1080, 720), None)]
            log_path = home/'app.log'
            try:
                with log_path.open('w') as log:
                    for expected, resized in steps:
                        process = subprocess.Popen([executable], env=env, stdout=log, stderr=log)
                        window = wait_for(lambda: find_window(display, x.XDefaultRootWindow(display)), process)
                        wait_for(lambda: size(display, window) == expected, process)
                        if resized:
                            x.XResizeWindow(display, window, *resized)
                            x.XFlush(display)
                            wait_for(lambda: size(display, window) == resized, process)
                        close(display, window, process)
                        saved = json.loads(cache.read_text())['main']
                        assert (saved['width'], saved['height']) == (resized or expected), saved
                    # A damaged cache must not stop users from opening their wallet.
                    cache.write_text('{invalid')
                    process = subprocess.Popen([executable], env=env, stdout=log, stderr=log)
                    window = wait_for(lambda: find_window(display, x.XDefaultRootWindow(display)), process)
                    wait_for(lambda: size(display, window) == (1440, 1000), process)
                    close(display, window, process)
            except Exception:
                if log_path.exists():
                    print('Packaged app log:', file=sys.stderr)
                    print(log_path.read_text(errors='replace'), file=sys.stderr)
                raise
            print(json.dumps({'restored_sizes': [[1210, 840], [1080, 720]], 'invalid_cache': 'default size restored'}))
    finally:
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        x.XCloseDisplay(display)


if __name__ == '__main__':
    main()

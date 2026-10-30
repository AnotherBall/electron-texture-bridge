// Child window hosting the preview swapchain.
//
// Created on the caller's thread (Electron's UI thread, which owns the
// parent) so no thread input is attached and HTTRANSPARENT hit-testing hands
// mouse input to Chromium's own child window underneath.

use crate::preview_layout::Bounds;
use std::sync::OnceLock;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{
    GetLastError, ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HMODULE, HWND, LPARAM, LRESULT, WPARAM,
};
use windows::Win32::Graphics::Gdi::ValidateRect;
use windows::Win32::System::LibraryLoader::{
    GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
    GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, IsWindow, RegisterClassExW, SetWindowPos,
    ShowWindow, HTTRANSPARENT, HWND_TOP, SWP_NOACTIVATE, SW_HIDE, SW_SHOWNA, WM_ERASEBKGND,
    WM_NCHITTEST, WM_PAINT, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS, WS_EX_NOPARENTNOTIFY,
    WS_EX_NOREDIRECTIONBITMAP,
};

const CLASS_NAME: PCWSTR = w!("ElectronTextureBridgePreviewView");

pub struct ChildWindow {
    hwnd: HWND,
}

impl ChildWindow {
    /// Create a hidden child of `parent` (a raw HWND).
    pub fn create(parent: usize) -> Result<Self, String> {
        let parent = HWND(parent as *mut _);
        if !unsafe { IsWindow(parent) }.as_bool() {
            return Err("Parent handle is not a valid window".into());
        }
        let instance = register_class()?;
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_NOREDIRECTIONBITMAP | WS_EX_NOPARENTNOTIFY,
                CLASS_NAME,
                w!("PreviewView"),
                WS_CHILD | WS_CLIPSIBLINGS,
                0,
                0,
                0,
                0,
                parent,
                None,
                instance,
                None,
            )
        }
        .map_err(|e| format!("CreateWindowExW failed for PreviewView: {e}"))?;
        Ok(Self { hwnd })
    }

    /// Raw HWND for the render thread (HWND itself is not `Send`).
    pub fn raw(&self) -> usize {
        self.hwnd.0 as usize
    }

    /// Move / resize within the parent's client area and keep the view above
    /// Chromium's own child window.
    pub fn set_bounds(&self, bounds: Bounds) {
        let result = unsafe {
            SetWindowPos(
                self.hwnd,
                HWND_TOP,
                bounds.x,
                bounds.y,
                bounds.width as i32,
                bounds.height as i32,
                SWP_NOACTIVATE,
            )
        };
        if let Err(e) = result {
            eprintln!("[PreviewView] SetWindowPos failed: {e}");
        }
    }

    /// Show without activating, or hide.
    pub fn set_shown(&self, shown: bool) {
        let command = if shown { SW_SHOWNA } else { SW_HIDE };
        // The return value is the previous visibility, not an error.
        let _ = unsafe { ShowWindow(self.hwnd, command) };
    }
}

impl Drop for ChildWindow {
    fn drop(&mut self) {
        // Fails harmlessly when the parent already destroyed us.
        let _ = unsafe { DestroyWindow(self.hwnd) };
    }
}

/// Whether `hwnd` (raw) still refers to a live window. Safe from any thread.
pub fn is_window_alive(hwnd: usize) -> bool {
    unsafe { IsWindow(HWND(hwnd as *mut _)) }.as_bool()
}

/// Register the window class once per process, under this DLL's module so
/// the class's WndProc always lives in the module that registered it.
fn register_class() -> Result<HINSTANCE, String> {
    static REGISTERED: OnceLock<Result<usize, String>> = OnceLock::new();
    REGISTERED
        .get_or_init(|| {
            let instance = module_instance()?;
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(wnd_proc),
                hInstance: instance,
                lpszClassName: CLASS_NAME,
                ..Default::default()
            };
            let atom = unsafe { RegisterClassExW(&class) };
            if atom == 0 && unsafe { GetLastError() } != ERROR_CLASS_ALREADY_EXISTS {
                return Err("RegisterClassExW failed for PreviewView".into());
            }
            Ok(instance.0 as usize)
        })
        .clone()
        .map(|raw| HINSTANCE(raw as *mut _))
}

/// HINSTANCE of the module containing this code (the .node addon).
fn module_instance() -> Result<HINSTANCE, String> {
    let mut module = HMODULE::default();
    unsafe {
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            PCWSTR(wnd_proc as *const u16),
            &mut module,
        )
    }
    .map_err(|e| format!("GetModuleHandleExW failed: {e}"))?;
    Ok(module.into())
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        // Let the mouse fall through to Chromium beneath the preview.
        WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
        // The swapchain owns every pixel; never let GDI paint over it.
        WM_ERASEBKGND => LRESULT(1),
        WM_PAINT => {
            let _ = ValidateRect(hwnd, None);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

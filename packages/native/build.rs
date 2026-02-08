fn main() {
    napi_build::setup();

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let workspace_root = std::path::Path::new(&manifest_dir)
        .parent()
        .unwrap() // packages/
        .parent()
        .unwrap(); // root
    let vendor_dir = workspace_root.join("vendor");

    #[cfg(target_os = "windows")]
    build_windows(&vendor_dir);

    #[cfg(target_os = "macos")]
    build_macos(&vendor_dir);
}

#[cfg(target_os = "windows")]
fn build_windows(vendor_dir: &std::path::Path) {
    let spout_dir = vendor_dir.join("SpoutDX");

    // SpoutDX の C++ ソースをビルド
    // vendor/SpoutDX/ に Spout2 SDK のソースを配置すること
    cc::Build::new()
        .cpp(true)
        .file("cpp/win/spout_bridge.cpp")
        .file(spout_dir.join("SpoutDX.cpp"))
        .file(spout_dir.join("SpoutDirectX.cpp"))
        .file(spout_dir.join("SpoutSenderNames.cpp"))
        .file(spout_dir.join("SpoutFrameCount.cpp"))
        .file(spout_dir.join("SpoutUtils.cpp"))
        .file(spout_dir.join("SpoutCopy.cpp"))
        .file(spout_dir.join("SpoutSharedMemory.cpp"))
        .include(&spout_dir)
        .include("cpp/win")
        .flag("/EHsc")
        .flag("/std:c++17")
        .compile("spout_bridge");

    println!("cargo:rustc-link-lib=d3d11");
    println!("cargo:rustc-link-lib=dxgi");
    println!("cargo:rustc-link-lib=user32");
    println!("cargo:rustc-link-lib=gdi32");
    println!("cargo:rustc-link-lib=shell32");
    println!("cargo:rustc-link-lib=ole32");
    println!("cargo:rustc-link-lib=comdlg32");
    println!("cargo:rustc-link-lib=comctl32");
    println!("cargo:rustc-link-lib=shlwapi");
}

#[cfg(target_os = "macos")]
fn build_macos(vendor_dir: &std::path::Path) {
    let vendor_str = vendor_dir.to_str().unwrap();

    // Syphon Metal の ObjC++ ブリッジをビルド
    cc::Build::new()
        .file("cpp/mac/syphon_bridge.mm")
        .include("cpp/mac")
        .flag("-ObjC++")
        .flag("-std=c++17")
        .flag("-fobjc-arc")
        // Syphon.framework の場所
        .flag("-F")
        .flag(vendor_str)
        .compile("syphon_bridge");

    // フレームワークリンク
    println!("cargo:rustc-link-lib=framework=Syphon");
    println!("cargo:rustc-link-lib=framework=Metal");
    println!("cargo:rustc-link-lib=framework=IOSurface");
    println!("cargo:rustc-link-lib=framework=Cocoa");
    println!("cargo:rustc-link-lib=framework=QuartzCore");

    // Syphon.framework の検索パス
    println!("cargo:rustc-link-search=framework={vendor_str}");

    // rpath を設定（ランタイムでフレームワークを見つけられるように）
    // @loader_path/../../vendor: .node は packages/native/ にあり、vendor/ はリポジトリルート
    // @executable_path/../Frameworks: Electron アプリバンドル用
    println!("cargo:rustc-cdylib-link-arg=-Wl,-rpath,@loader_path/../../vendor");
    println!("cargo:rustc-cdylib-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
}

fn main() {
    napi_build::setup();

    #[cfg(target_os = "windows")]
    build_windows();

    #[cfg(target_os = "macos")]
    build_macos();
}

#[cfg(target_os = "windows")]
fn build_windows() {
    // SpoutDX の C++ ソースをビルド
    // vendor/SpoutDX/ に Spout2 SDK のソースを配置すること
    cc::Build::new()
        .cpp(true)
        .file("cpp/win/spout_bridge.cpp")
        .file("vendor/SpoutDX/SpoutDX.cpp")
        .file("vendor/SpoutDX/SpoutDirectX.cpp")
        .file("vendor/SpoutDX/SpoutSenderNames.cpp")
        .file("vendor/SpoutDX/SpoutFrameCount.cpp")
        .file("vendor/SpoutDX/SpoutUtils.cpp")
        .include("vendor/SpoutDX")
        .include("cpp/win")
        .flag("/EHsc")
        .flag("/std:c++17")
        .compile("spout_bridge");

    println!("cargo:rustc-link-lib=d3d11");
    println!("cargo:rustc-link-lib=dxgi");
}

#[cfg(target_os = "macos")]
fn build_macos() {
    // Syphon Metal の ObjC++ ブリッジをビルド
    cc::Build::new()
        .file("cpp/mac/syphon_bridge.mm")
        .include("cpp/mac")
        .flag("-ObjC++")
        .flag("-std=c++17")
        .flag("-fobjc-arc")
        // Syphon.framework の場所
        .flag("-F")
        .flag("vendor")
        .compile("syphon_bridge");

    // フレームワークリンク
    println!("cargo:rustc-link-lib=framework=Syphon");
    println!("cargo:rustc-link-lib=framework=Metal");
    println!("cargo:rustc-link-lib=framework=IOSurface");
    println!("cargo:rustc-link-lib=framework=Cocoa");
    println!("cargo:rustc-link-lib=framework=QuartzCore");

    // Syphon.framework の検索パス
    println!("cargo:rustc-link-search=framework=vendor");

    // rpath を設定（ランタイムでフレームワークを見つけられるように）
    // @loader_path: .node ファイルと同じディレクトリ
    // @loader_path/vendor: .node の親の vendor ディレクトリ
    // @executable_path/../Frameworks: Electron アプリバンドル用
    println!("cargo:rustc-cdylib-link-arg=-Wl,-rpath,@loader_path");
    println!("cargo:rustc-cdylib-link-arg=-Wl,-rpath,@loader_path/vendor");
    println!("cargo:rustc-cdylib-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
}

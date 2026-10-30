# やりたいこと

## Native preview view（Windows 先行、macOS は次）

Avvy Studio（persona-electron）の Stage プレビューを、Chromium で描かずに OBS と同じくネイティブで描く。
受信した Spout フレームを main → renderer に転送して canvas に描く今の方法では、60 fps 届いていても OBS より滑らかに見えない。

### 決まったこと

- 親ウィンドウ（Electron の `BrowserWindow.getNativeWindowHandle()`）の中に子ウィンドウを作り、そこへ自前の D3D11 flip-model swapchain で描く。
  - 表示の vsync に合わせて毎リフレッシュ Present する（OBS のプレビューと同じ）。
  - 毎回いちばん新しい Spout フレームを使う。
  - 背景は単色で塗り、その上に premultiplied alpha のフレームをアスペクト比を保って中央に描く。
- 位置・大きさは親のクライアント領域の物理ピクセルで指定する。移動・リサイズ・表示/非表示ができる。
- Node への API（napi）は小さくし、Electron の API には依存しない。macOS（NSView + Metal、Syphon の IOSurface）でも同じ形で使える。
  - `new PreviewView(parentHandle: Buffer, senderName: string)`
  - `setBounds(x, y, width, height)` / `setVisible(visible)` / `setBackground(r, g, b)`（0–255）/ `destroy()`
  - `getStats()`（Present 回数・新しいフレームを描いた回数。滑らかさの比較用）
- マウスは子ウィンドウで止めず、下の Chromium に通す（`WM_NCHITTEST` で `HTTRANSPARENT`）。効かなければ未対応として残す。

### persona-electron 側の試作（内部ビルドの環境変数フラグの裏）

- Stage プレビュー（`.avatar-stage-frame > .stage-output`）の上にこのビューを出し、要素の位置・大きさに追従させる。アバター画面が出ていないときは隠す。
- フラグが ON の間は、Stage プレビュー用の main → renderer 転送を止める。
- 背景: 設定が「単色」ならその色、それ以外（avvy・透明・画像・キャプチャ）は固定の 1 色。
- ローカルビルドを使う。パッケージの公開は別に決める。

### 未対応（試作では扱わない）

- HTML のオーバーレイはネイティブビューの上に描けない。
- 背景の画像・キャプチャ・透明・avvy 表示。
- プレビュー上のカメラ操作（ドラッグ・ホイール）は、マウスが Chromium に届くかどうか次第。

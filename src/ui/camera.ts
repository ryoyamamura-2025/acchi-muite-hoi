export interface CameraHandle {
  stop(): void;
}

/**
 * Web カメラを開いて `video` に流す。
 * 鏡表示（CSS の `transform: scaleX(-1)`）は styles.css 側で当てている。
 */
export async function startCamera(video: HTMLVideoElement): Promise<CameraHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'このページではカメラを使えません。http://localhost もしくは https:// で開いてください。',
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
  } catch (error) {
    throw new Error(cameraErrorMessage(error));
  }

  video.srcObject = stream;
  await video.play();
  // メタデータが来るまで videoWidth が 0 で、そのまま推論すると落ちる。
  if (video.videoWidth === 0) {
    await new Promise<void>((resolve) => {
      video.addEventListener('loadeddata', () => resolve(), { once: true });
    });
  }

  // このアプリは画面更新時に同じ video 要素を別の cameraSlot へ付け替える。
  // Android Chrome では DOM から一度外れた video が同じフレームのまま止まることがあるため、
  // 再接続を検知したら明示的に play() してプレビューを継続させる。
  let resumeQueued = false;
  const resumeIfConnected = () => {
    if (resumeQueued || !video.isConnected || video.srcObject !== stream) return;
    resumeQueued = true;
    queueMicrotask(() => {
      resumeQueued = false;
      if (!video.isConnected || video.srcObject !== stream) return;
      void video.play().catch(() => {
        // 自動再生が一時的に拒否されても、次の DOM 接続時に再試行する。
      });
    });
  };
  const observer = new MutationObserver(resumeIfConnected);
  observer.observe(document.body, { childList: true, subtree: true });

  return {
    stop() {
      observer.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    },
  };
}

/** 映像が実際に流れていて推論に使える状態か。 */
export function isCameraReady(video: HTMLVideoElement): boolean {
  return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0;
}

function cameraErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'カメラの使用が許可されませんでした。ブラウザのアドレスバーからカメラを許可して再読み込みしてください。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'カメラが見つかりませんでした。接続を確認してください。';
    case 'NotReadableError':
      return 'カメラを他のアプリが使用中の可能性があります。閉じてから再読み込みしてください。';
    default:
      return `カメラを起動できませんでした: ${error instanceof Error ? error.message : String(error)}`;
  }
}
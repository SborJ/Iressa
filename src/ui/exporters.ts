/**
 * Handing the run's exact state back out.
 *
 * The frame has to be captured in the same animation frame it was drawn in:
 * the drawing buffer is not preserved between frames, so a capture requested
 * now is served by the loop at the end of its next render rather than here.
 */

export function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(filename: string, text: string, type = 'application/json'): void {
  download(filename, new Blob([text], { type }));
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Set by a button, consumed by the render loop one frame later. */
export class FrameCapture {
  private pending = false;

  request(): void {
    this.pending = true;
  }

  /** Call immediately after the renderer has drawn, while the buffer is valid. */
  take(canvas: HTMLCanvasElement, stamp: string): void {
    if (!this.pending) return;
    this.pending = false;
    canvas.toBlob((blob) => {
      if (blob) download(`iressa-${stamp}.png`, blob);
    }, 'image/png');
  }
}

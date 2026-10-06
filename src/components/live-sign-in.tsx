"use client";

import Link from "next/link";
import { useCallback, useReducer, useRef } from "react";

// CHE-419: the live view a person signs in through. Frames of one tab come in
// as JPEG; mouse, keys and pasted text go out as a closed list of messages the
// session host turns into input (spikes/shopify-session/viewer.mjs).
//
// Paste is ours, not the remote browser's: a hidden field here keeps the
// focus, the browser hands it the clipboard on Cmd+V / Ctrl+V, and its text is
// sent as typed text. That is the whole reason this page exists — on the VNC
// console Cmd+V did nothing (2026-10-05).
//
// The socket is opened by the stage's ref callback and closed by its cleanup
// (React 19): it lives exactly as long as the element, with no effect.

type Status =
  | { kind: "connecting" }
  | { kind: "live"; host: string | null }
  | { kind: "signed_in"; store: string }
  | { kind: "closed"; message: string };
type Dialog = { kind: string; message: string } | null;
type State = { status: Status; dialog: Dialog };
type Action =
  | { t: "live" }
  | { t: "page"; host: string }
  | { t: "signed_in"; store: string }
  | { t: "dialog"; dialog: Dialog }
  | { t: "closed"; message: string };

function reduce(state: State, action: Action): State {
  switch (action.t) {
    case "live":
      return state.status.kind === "connecting" ? { ...state, status: { kind: "live", host: null } } : state;
    case "page":
      return state.status.kind === "live" ? { ...state, status: { kind: "live", host: action.host } } : state;
    case "signed_in":
      return { ...state, status: { kind: "signed_in", store: action.store } };
    case "dialog":
      return { ...state, dialog: action.dialog };
    case "closed":
      // Signed in stays signed in: the socket closing after that is not news.
      return state.status.kind === "signed_in" ? state : { ...state, status: { kind: "closed", message: action.message } };
  }
}

const SPECIAL: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { code: "Backspace", keyCode: 8 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Delete: { code: "Delete", keyCode: 46 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
};
// Cmd (or Ctrl) + a letter that edits text: done by the remote browser's own
// command, whatever its platform's shortcut is.
const COMMANDS: Record<string, string> = { a: "selectAll", z: "undo", x: "cut", c: "copy" };

const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

export function LiveSignIn({ url, store, appHref }: { url: string; store: string; appHref: string }) {
  const [state, dispatch] = useReducer(reduce, { status: { kind: "connecting" }, dialog: null });
  const socket = useRef<WebSocket | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const size = useRef({ w: 1280, h: 720 });

  const say = (message: object) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  };

  const stage = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      socket.current = ws;
      let drawing = false;
      ws.onopen = () => dispatch({ t: "live" });
      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const target = canvas.current;
          if (!target || drawing) return;
          drawing = true;
          void createImageBitmap(new Blob([event.data], { type: "image/jpeg" }))
            .then((bitmap) => {
              target.getContext("2d")?.drawImage(bitmap, 0, 0, target.width, target.height);
              bitmap.close();
            })
            .finally(() => { drawing = false; });
          return;
        }
        const message = JSON.parse(String(event.data));
        if (message.t === "meta" && canvas.current) {
          size.current = { w: message.w, h: message.h };
          canvas.current.width = message.w;
          canvas.current.height = message.h;
        } else if (message.t === "page") dispatch({ t: "page", host: message.host });
        else if (message.t === "signed_in") dispatch({ t: "signed_in", store: message.store });
        else if (message.t === "dialog") dispatch({ t: "dialog", dialog: { kind: message.kind, message: message.message } });
        else if (message.t === "error") dispatch({ t: "closed", message: message.message });
      };
      ws.onclose = () => dispatch({ t: "closed", message: "The connection ended. Reload this page to continue." });
      field.current?.focus();
      return () => {
        socket.current = null;
        ws.close();
      };
    },
    [url],
  );

  const point = (e: React.MouseEvent<HTMLCanvasElement> | React.WheelEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * size.current.w,
      y: ((e.clientY - rect.top) / rect.height) * size.current.h,
    };
  };
  const BUTTON = ["left", "middle", "right"] as const;
  const lastMove = useRef(0);
  const MOUSE: Record<string, string> = { mousedown: "mousePressed", mouseup: "mouseReleased", mousemove: "mouseMoved" };
  const mouse = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const type = MOUSE[e.type];
    if (!type) return;
    // Hover is enough at ~20 moves a second; a drag (a button held) is not thinned.
    if (type === "mouseMoved" && !(e.buttons & 1)) {
      if (e.timeStamp - lastMove.current < 50) return;
      lastMove.current = e.timeStamp;
    }
    if (type === "mousePressed") {
      e.preventDefault();
      field.current?.focus();
    }
    const button = type === "mouseMoved" ? (e.buttons & 1 ? "left" : "none") : (BUTTON[e.button] ?? "left");
    say({ t: "mouse", type, ...point(e), button, clickCount: type === "mouseMoved" ? 0 : e.detail || 1, modifiers: modifiers(e) });
  };

  const keyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const command = e.metaKey || e.ctrlKey;
    if (command) {
      const key = e.key.toLowerCase();
      // Cmd+V / Ctrl+V: let the browser fire the paste event below.
      if (key === "v") return;
      const name = key === "z" && e.shiftKey ? "redo" : COMMANDS[key];
      if (!name) return; // the browser's own shortcuts stay the browser's
      e.preventDefault();
      say({ t: "key", type: "keyDown", key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), commands: [name] });
      say({ t: "key", type: "keyUp", key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) });
      return;
    }
    const special = SPECIAL[e.key];
    if (special) {
      e.preventDefault();
      say({ t: "key", type: "keyDown", key: e.key, ...special, modifiers: modifiers(e) });
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      say({ t: "key", type: "keyDown", key: e.key, code: e.code, keyCode: e.key.toUpperCase().charCodeAt(0), text: e.key, modifiers: e.shiftKey ? 8 : 0 });
    }
  };
  const keyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.metaKey || e.ctrlKey) return;
    const special = SPECIAL[e.key];
    if (special) say({ t: "key", type: "keyUp", key: e.key, code: special.code, keyCode: special.keyCode, modifiers: modifiers(e) });
    else if (e.key.length === 1) say({ t: "key", type: "keyUp", key: e.key, code: e.code, keyCode: e.key.toUpperCase().charCodeAt(0) });
  };
  const paste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (text) say({ t: "text", text });
  };

  const { status, dialog } = state;
  return (
    <div className="mt-6">
      <div className="mb-3 flex min-h-6 items-center justify-between gap-4 text-sm">
        {status.kind === "connecting" && <span className="text-fg-muted">Opening the browser…</span>}
        {status.kind === "live" && <span className="text-fg-muted">Click into the page and sign in. Paste works as usual (⌘V / Ctrl+V).</span>}
        {status.kind === "signed_in" && (
          <span className="text-accent">
            Signed in to {status.store}. Checks of this app will open it from your admin. You can close this page —{" "}
            <Link href={appHref} className="underline">back to the app</Link>.
          </span>
        )}
        {status.kind === "closed" && <span>{status.message}</span>}
        <span className="flex gap-2">
          <button type="button" className="rounded border border-ink-700 px-2 py-1 text-[13px] hover:text-accent" onClick={() => say({ t: "nav", action: "back" })}>Back</button>
          <button type="button" className="rounded border border-ink-700 px-2 py-1 text-[13px] hover:text-accent" onClick={() => say({ t: "nav", action: "reload" })}>Reload</button>
        </span>
      </div>
      {dialog && (
        <div className="mb-3 flex items-center justify-between gap-4 rounded border border-ink-700 p-3 text-sm">
          <span>{dialog.message}</span>
          <span className="flex gap-2">
            <button type="button" className="rounded border border-ink-700 px-2 py-1" onClick={() => { say({ t: "dialog", accept: true }); dispatch({ t: "dialog", dialog: null }); }}>OK</button>
            {dialog.kind !== "alert" && (
              <button type="button" className="rounded border border-ink-700 px-2 py-1" onClick={() => { say({ t: "dialog", accept: false }); dispatch({ t: "dialog", dialog: null }); }}>Cancel</button>
            )}
          </span>
        </div>
      )}
      <div ref={stage} className="relative overflow-hidden rounded border border-ink-700 bg-black">
        <canvas
          ref={canvas}
          width={1280}
          height={720}
          aria-label={`Sign-in page for ${store}`}
          className="block h-auto w-full cursor-default select-none"
          onMouseDown={mouse}
          onMouseUp={mouse}
          onMouseMove={mouse}
          onContextMenu={(e) => e.preventDefault()}
          onWheel={(e) => say({ t: "mouse", type: "mouseWheel", ...point(e), button: "none", deltaX: e.deltaX, deltaY: e.deltaY })}
        />
        <textarea
          ref={field}
          aria-label="Keyboard input for the sign-in page"
          className="absolute left-0 top-0 h-px w-px opacity-0"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={keyDown}
          onKeyUp={keyUp}
          onPaste={paste}
          value=""
          onChange={() => {}}
        />
      </div>
    </div>
  );
}

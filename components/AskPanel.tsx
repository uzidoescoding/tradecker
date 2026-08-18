"use client";

import { useEffect, useRef, useState } from "react";

export type Turn = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "I do not follow what I am looking at. Explain this page.",
  "What does the chip that says L1/L2 mean?",
  "What is the difference between agreement score and entry score here?",
  "Which of these rows would you not touch, and why?",
  "Is this board concentrated in one sector?",
];

/**
 * Side panel for questions about the whole board.
 *
 * It is a parallel panel, not a modal task, so on a wide screen it gets no
 * dimming scrim: the board stays fully readable and usable underneath while you
 * ask about it. On a narrow screen there is no room for both, so it becomes an
 * overlay and takes the scrim. It enters from the right and leaves to the
 * right, always the same path.
 */
export default function AskPanel({
  open,
  onClose,
  context,
}: {
  open: boolean;
  onClose: () => void;
  context: unknown;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setDraft("");
    setError("");
    // The user's turn lands immediately. Waiting for the round trip to show
    // what they just typed makes the panel feel broken.
    const history = turns;
    setTurns([...history, { role: "user", content: q }]);
    setBusy(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, context, history }),
      });
      const json = await res.json();
      if (json.error && !json.text) setError(json.error);
      else setTurns((t) => [...t, { role: "assistant", content: json.text }]);
    } catch {
      setError("Could not reach the desk.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Scrim only where the panel actually covers the board. */}
      {open && <div className="ask-scrim lg:hidden" onClick={onClose} aria-hidden />}

      <aside
        className="ask-panel"
        data-open={open}
        aria-hidden={!open}
        aria-label="Ask the desk"
        // Focus must not land inside a panel that is off screen. React 19 takes
        // `inert` as a real boolean prop; passing an empty string instead makes
        // it warn and treats the attribute as false, which is the opposite of
        // what is wanted here.
        inert={!open}
      >
        <div
          className="flex flex-none items-center justify-between gap-3 px-4 py-3"
          style={{ borderBottom: "1px solid var(--hairline)" }}
        >
          <div>
            <p className="t-title">Ask the desk</p>
            <p className="t-caption">Questions about the board on screen</p>
          </div>
          <button
            onClick={onClose}
            className="pressable t-caption rounded-full px-3 py-1"
            style={{ background: "var(--hairline)", color: "var(--text-2)" }}
          >
            Close
          </button>
        </div>

        <div ref={scroller} className="scroll-panel min-h-0 flex-1 px-4 py-3">
          {turns.length === 0 && (
            <>
              <p className="t-caption">
                Ask about anything on the page, or about a term you have not met before. For live
                numbers it can only see this board, so it has no news, no price history beyond what
                is here, and no memory of previous sessions.
              </p>
              <div className="mt-3 space-y-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    className="chip-suggest pressable"
                    disabled={busy}
                    onClick={() => send(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="space-y-3">
            {turns.map((t, i) => (
              <div key={i} className={t.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <p
                  className={`t-body max-w-[85%] px-3 py-2 ${t.role === "user" ? "bubble-user" : "bubble-ai"}`}
                >
                  {t.content}
                </p>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <p className="bubble-ai bubble-thinking px-3 py-2" role="status" aria-label="Thinking">
                  <span className="dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </p>
              </div>
            )}
          </div>

          {error && (
            <p className="t-caption mt-3" style={{ color: "var(--down)" }}>
              {error}
            </p>
          )}
        </div>

        <form
          className="flex-none px-4 pt-2 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
        >
          <div className="ask-bar flex items-center gap-2">
            <input
              ref={input}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask about the board"
              maxLength={600}
              className="t-body min-w-0 flex-1 bg-transparent outline-none"
            />
            <button type="submit" className="ask-send pressable" disabled={busy || !draft.trim()}>
              Ask
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}

import { forwardRef } from "react";

interface EditorProps {
  value: string;
  fontSize: number;
  onChange: (v: string) => void;
}

export const Editor = forwardRef<HTMLTextAreaElement, EditorProps>(
  function Editor({ value, fontSize, onChange }, ref) {
    return (
      <textarea
        ref={ref}
        className="editor"
        style={{ fontSize }}
        value={value}
        spellCheck={false}
        placeholder="Start sketching…"
        onChange={(e) => onChange(e.target.value)}
      />
    );
  },
);

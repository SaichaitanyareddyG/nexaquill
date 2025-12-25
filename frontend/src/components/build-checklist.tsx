import type { JSX } from "react";

type BuildChecklistProps = {
  voiceActive: boolean;
  uploadCount: number;
  recentUploads: string[];
};

const baseChecklist = [
  { label: "Wire realtime token + SDP", key: "realtime" },
  { label: "Implement autosuggest API", key: "suggest" },
  { label: "Connect document summarisation", key: "docs" },
  { label: "Add session analytics + logs", key: "analytics" },
];

export function BuildChecklist({
  voiceActive,
  uploadCount,
  recentUploads,
}: BuildChecklistProps): JSX.Element {
  return (
    <aside className="nexa-panel nexa-panel--secondary">
      <header className="panel-head">
        <div>
          <h2>Build checklist</h2>
          <p>Track what’s next while you finish the integrations.</p>
        </div>
      </header>
      <div className="summary-grid">
        <div className="summary-card">
          <p className="summary-card__label">Voice mode</p>
          <p className={`summary-card__status ${voiceActive ? "summary-card__status--on" : ""}`}>
            {voiceActive ? "Live" : "Idle"}
          </p>
          <p className="summary-card__hint">
            {voiceActive
              ? "Voice is active. Realtime will stream once credentials are ready."
              : "Enable voice to preview the UI pulse and monitoring state."}
          </p>
        </div>
        <div className="summary-card">
          <p className="summary-card__label">Uploads staged</p>
          <p className="summary-card__status">{uploadCount}</p>
          <p className="summary-card__hint">
            {uploadCount === 0
              ? "Try attaching a PDF or image to see the preview list."
              : "Latest file: " + recentUploads[0]}
          </p>
        </div>
      </div>

      <ul className="checklist">
        {baseChecklist.map((item) => (
          <li key={item.key}>
            <input
              type="checkbox"
              checked={item.key === "realtime"}
              readOnly
            />
            {item.label}
          </li>
        ))}
      </ul>
      <div className="note-card">
        <h3>Prototype notes</h3>
        <p>
          The UI remains responsive while services initialise. Swap to live endpoints by updating the environment
          variables once keys arrive.
        </p>
      </div>
      {recentUploads.length > 0 && (
        <div className="upload-preview">
          <p className="upload-preview__title">Recent attachments</p>
          <ul>
            {recentUploads.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

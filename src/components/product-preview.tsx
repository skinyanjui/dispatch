"use client";
import { useState } from "react";

/**
 * A picture of the workspace, drawn in plain markup with made-up sample
 * values. It is not a screenshot of live data and says so.
 */
const tabs = [
  {
    id: "board",
    label: "Board",
    text: "Every load in its stage, with what is next and who has it.",
  },
  {
    id: "table",
    label: "Table",
    text: "Sort, group and hide columns, then save the view.",
  },
  {
    id: "calendar",
    label: "Calendar",
    text: "See appointments across the month.",
  },
  {
    id: "documents",
    label: "Documents",
    text: "Templates fill into drafts a person reviews.",
  },
] as const;
type Tab = (typeof tabs)[number]["id"];

const loads = [
  [
    "QA-1042",
    "Blue Ridge Transport",
    "Chicago, IL → Nashville, TN",
    "$2,500.00",
  ],
  [
    "QA-1043",
    "Prairie Line Logistics",
    "Dallas, TX → Memphis, TN",
    "$1,850.00",
  ],
  [
    "QA-1044",
    "Blue Ridge Transport",
    "Atlanta, GA → Columbus, OH",
    "$2,100.00",
  ],
];

export function ProductPreview() {
  const [tab, setTab] = useState<Tab>("board");
  return (
    <div className="preview">
      <div className="previewTabs" role="tablist" aria-label="Product views">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={"pv-tab-" + t.id}
            aria-selected={tab === t.id}
            aria-controls="pv-panel"
            className={tab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="previewText">{tabs.find((t) => t.id === tab)!.text}</p>
      <div
        className="previewFrame"
        role="tabpanel"
        id="pv-panel"
        aria-labelledby={"pv-tab-" + tab}
      >
        <div className="previewSide" aria-hidden="true">
          {[
            "Loads",
            "Exceptions",
            "Inbox",
            "Carriers",
            "Documents",
            "Billing",
          ].map((n) => (
            <span
              key={n}
              className={
                n === (tab === "documents" ? "Documents" : "Loads") ? "on" : ""
              }
            >
              {n}
            </span>
          ))}
        </div>
        <div className="previewMain" aria-hidden="true">
          {tab === "board" && (
            <div className="pvBoard">
              {["Booked", "Dispatched", "In transit"].map((col, i) => (
                <div key={col}>
                  <b>{col}</b>
                  {loads.slice(0, 3 - i).map((l) => (
                    <div key={l[0]} className="pvCard">
                      <strong>{l[0]}</strong>
                      <span>{l[1]}</span>
                      <span>{l[2]}</span>
                      <em>{l[3]}</em>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {tab === "table" && (
            <table className="pvTable">
              <thead>
                <tr>
                  <th>Load</th>
                  <th>Carrier</th>
                  <th>Route</th>
                  <th>Freight</th>
                </tr>
              </thead>
              <tbody>
                {loads.map((l) => (
                  <tr key={l[0]}>
                    {l.map((c) => (
                      <td key={c}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {tab === "calendar" && (
            <div className="pvCal">
              {Array.from({ length: 21 }, (_, i) => (
                <div key={i}>
                  <small>{i + 1}</small>
                  {[3, 8, 12, 15].includes(i) && (
                    <span>QA-10{40 + (i % 5)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {tab === "documents" && (
            <div className="pvDoc">
              <b>Draft · Check call · QA-1042</b>
              <p>
                Hi Jordan, checking on QA-1042 for Blue Ridge Transport. Is the
                pickup on track for 9:00 AM? — Alex
              </p>
              <span>Needs review</span>
            </div>
          )}
        </div>
      </div>
      <small className="previewNote">
        A drawing with made-up sample values, not live data.
      </small>
    </div>
  );
}

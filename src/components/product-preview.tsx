"use client";
import { useState } from "react";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { DataTable, type ColumnDefinition } from "@/components/ui/data-table";

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

/** Made-up sample loads for the drawing; never real data. */
type SampleLoad = {
  reference: string;
  carrier: string;
  route: string;
  freight: string;
};
const loads: SampleLoad[] = [
  {
    reference: "QA-1042",
    carrier: "Blue Ridge Transport",
    route: "Chicago, IL → Nashville, TN",
    freight: "$2,500.00",
  },
  {
    reference: "QA-1043",
    carrier: "Prairie Line Logistics",
    route: "Dallas, TX → Memphis, TN",
    freight: "$1,850.00",
  },
  {
    reference: "QA-1044",
    carrier: "Blue Ridge Transport",
    route: "Atlanta, GA → Columbus, OH",
    freight: "$2,100.00",
  },
];
const columns: ColumnDefinition<SampleLoad>[] = [
  { id: "reference", header: "Load", accessor: "reference" },
  { id: "carrier", header: "Carrier", accessor: "carrier" },
  { id: "route", header: "Route", accessor: "route", priority: "low" },
  { id: "freight", header: "Freight", accessor: "freight", align: "right" },
];

export function ProductPreview() {
  const [tab, setTab] = useState<Tab>("board");
  return (
    <div className="preview">
      <Tabs
        label="Product views"
        idPrefix="pv"
        className="previewTabs"
        items={tabs}
        value={tab}
        onChange={setTab}
      />
      <p className="previewText">{tabs.find((t) => t.id === tab)!.text}</p>
      <TabPanel idPrefix="pv" value={tab} className="previewFrame">
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
              {["Booked", "Dispatched", "In transit", "Delivered"].map(
                (col, i) => (
                  <div key={col}>
                    <b>{col}</b>
                    {loads.slice(0, [3, 2, 1, 1][i]).map((l) => (
                      <div key={l.reference} className="pvCard">
                        <span className="pvHead">
                          <strong>{l.reference}</strong>
                          <em>{l.freight}</em>
                        </span>
                        <span>{l.carrier}</span>
                        <span className="pvRoute">{l.route}</span>
                        <span className="pvChip">Docs {i === 3 ? 3 : 0}/3</span>
                      </div>
                    ))}
                  </div>
                ),
              )}
            </div>
          )}
          {tab === "table" && (
            <DataTable
              caption="Sample loads"
              className="pvTable"
              columns={columns}
              data={loads}
              getRowId={(l) => l.reference}
              empty={{ title: "No loads" }}
            />
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
      </TabPanel>
      <small className="previewNote">
        A drawing with made-up sample values, not live data.
      </small>
    </div>
  );
}

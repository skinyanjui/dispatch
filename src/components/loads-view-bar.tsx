"use client";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { useCallback, useEffect, useState } from "react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import {
  defaultView,
  fieldLabels,
  type ViewConfig,
  type ViewField,
} from "@/components/loads-views";
import { queues } from "@/components/workspace-shell";

type Filters = { status: string; carrier_id: string | null };
type Saved = {
  id: string;
  name: string;
  shared: boolean;
  mine: boolean;
  owner_name: string;
  config: ViewConfig & { filters: Filters };
};
const layouts = [
  ["board", "Board"],
  ["table", "Table"],
  ["calendar", "Calendar"],
] as const;

/**
 * Chooses how Loads are shown (board, table, calendar) and keeps named views.
 * A view stores display choices and filters only, never records.
 */
export function LoadsViewBar({
  config,
  onConfig,
  filters,
  carriers,
  onFilters,
  onApply,
  onAuthError,
}: {
  config: ViewConfig;
  onConfig: (patch: Partial<ViewConfig>) => void;
  filters: Filters;
  carriers: { id: string; name: string }[];
  /** Change only the status/carrier filters (the list reloads). */
  onFilters: (filters: Filters) => void;
  /** Apply a whole saved view (or the default). */
  onApply: (config: ViewConfig, filters: Filters) => void;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [views, setViews] = useState<Saved[]>([]),
    [current, setCurrent] = useState(""),
    [saving, setSaving] = useState(false),
    [name, setName] = useState(""),
    [shared, setShared] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState("");
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    },
    [onAuthError],
  );
  const load = useCallback(async () => {
    try {
      setViews((await api<{ views: Saved[] }>("views")).views);
    } catch {
      // Saved views are a convenience: the page works without them, and an
      // expired session is caught by the loads request itself.
    }
  }, [api]);
  useEffect(() => {
    // Fetch once on mount; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useEffect(() => {
    // The toolbar menus float over the list: a click elsewhere or Escape closes
    // them, and Escape returns focus to the menu button.
    const open = () =>
      document.querySelectorAll<HTMLDetailsElement>(
        "details.viewMenu[open], details.viewOptions[open]",
      );
    const onPointer = (e: PointerEvent) => {
      for (const d of open()) if (!d.contains(e.target as Node)) d.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      for (const d of open()) {
        d.open = false;
        d.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  const active = views.find((v) => v.id === current);
  const payload = () => ({ ...config, filters });
  async function run(fn: () => Promise<unknown>, done: string) {
    setError("");
    try {
      await fn();
      setStatus(done);
      await load();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }
  const hide = (f: ViewField, on: boolean) =>
    onConfig({
      hidden_fields: on
        ? config.hidden_fields.filter((x) => x !== f)
        : [...config.hidden_fields, f],
    });
  return (
    <div className="viewBar">
      <ToggleGroup
        label="Layout"
        variant="segmented"
        items={layouts.map(([id, label]) => ({ id, label }))}
        value={config.layout}
        onChange={(layout) => layout && onConfig({ layout })}
      />
      <label className="viewPicker">
        <span className="srOnly">Saved view</span>
        <select
          value={current}
          onChange={(e) => {
            const id = e.target.value;
            setCurrent(id);
            setStatus("");
            const v = views.find((x) => x.id === id);
            if (v) onApply({ ...defaultView, ...v.config }, v.config.filters);
            else onApply(defaultView, { status: "", carrier_id: null });
          }}
        >
          <option value="">Default view</option>
          {views.some((v) => v.mine) && (
            <optgroup label="My views">
              {views
                .filter((v) => v.mine)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.shared ? " (shared)" : ""}
                  </option>
                ))}
            </optgroup>
          )}
          {views.some((v) => !v.mine) && (
            <optgroup label="Shared with you">
              {views
                .filter((v) => !v.mine)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · {v.owner_name}
                  </option>
                ))}
            </optgroup>
          )}
        </select>
      </label>
      <div className="viewTools">
        <details className="viewMenu">
          <summary>
            Filter
            {(filters.status ? 1 : 0) + (filters.carrier_id ? 1 : 0) > 0 && (
              <span className="countBadge">
                {(filters.status ? 1 : 0) + (filters.carrier_id ? 1 : 0)}
              </span>
            )}
          </summary>
          <div className="viewOptionsBody">
            <label>
              Status
              <select
                value={filters.status}
                onChange={(e) =>
                  onFilters({ ...filters, status: e.target.value })
                }
              >
                {queues.map((q) => (
                  <option key={q.value} value={q.value}>
                    {q.label}
                  </option>
                ))}
              </select>
            </label>
            {carriers.length > 1 && (
              <label>
                Carrier
                <select
                  value={filters.carrier_id ?? ""}
                  onChange={(e) =>
                    onFilters({
                      ...filters,
                      carrier_id: e.target.value || null,
                    })
                  }
                >
                  <option value="">All carriers</option>
                  {carriers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              className="textButton"
              disabled={!filters.status && !filters.carrier_id}
              onClick={() => onFilters({ status: "", carrier_id: null })}
            >
              Clear filters
            </button>
          </div>
        </details>
        {config.layout === "table" && (
          <details className="viewMenu">
            <summary>Sort</summary>
            <div className="viewOptionsBody">
              <label>
                Sort by
                <select
                  value={config.sort.key}
                  onChange={(e) =>
                    onConfig({
                      sort: {
                        ...config.sort,
                        key: e.target.value as ViewConfig["sort"]["key"],
                      },
                    })
                  }
                >
                  <option value="reference">Load</option>
                  {(Object.keys(fieldLabels) as ViewField[]).map((f) => (
                    <option key={f} value={f}>
                      {fieldLabels[f]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Direction
                <select
                  value={config.sort.desc ? "desc" : "asc"}
                  onChange={(e) =>
                    onConfig({
                      sort: { ...config.sort, desc: e.target.value === "desc" },
                    })
                  }
                >
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
              </label>
            </div>
          </details>
        )}
        <details className="viewOptions">
          <summary>Options</summary>
          <div className="viewOptionsBody">
            {config.layout === "board" && (
              <label className="setupCheckbox">
                <input
                  type="checkbox"
                  checked={config.compact}
                  onChange={(e) => onConfig({ compact: e.target.checked })}
                />
                <span>Compact cards</span>
              </label>
            )}
            {config.layout === "table" && (
              <>
                <label>
                  Group by
                  <select
                    value={config.group_by}
                    onChange={(e) =>
                      onConfig({
                        group_by: e.target.value as ViewConfig["group_by"],
                      })
                    }
                  >
                    <option value="none">No grouping</option>
                    <option value="stage">Stage</option>
                    <option value="carrier">Carrier</option>
                  </select>
                </label>
                <fieldset className="opsChecklist">
                  <legend>Fields</legend>
                  {(Object.keys(fieldLabels) as ViewField[]).map((f) => (
                    <label key={f} className="setupCheckbox">
                      <input
                        type="checkbox"
                        checked={!config.hidden_fields.includes(f)}
                        onChange={(e) => hide(f, e.target.checked)}
                      />
                      <span>{fieldLabels[f]}</span>
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            {config.layout === "calendar" && (
              <label>
                Date field
                <select
                  value={config.calendar_field}
                  onChange={(e) =>
                    onConfig({
                      calendar_field: e.target
                        .value as ViewConfig["calendar_field"],
                    })
                  }
                >
                  <option value="next">Next appointment</option>
                  <option value="created">Created</option>
                </select>
              </label>
            )}
            <div className="viewActions">
              {active?.mine && (
                <>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void run(
                        () => api(`views/${active.id}`, { config: payload() }),
                        "View updated.",
                      )
                    }
                  >
                    Update “{active.name}”
                  </button>
                  <label className="setupCheckbox">
                    <input
                      type="checkbox"
                      checked={active.shared}
                      onChange={(e) =>
                        void run(
                          () =>
                            api(`views/${active.id}`, {
                              shared: e.target.checked,
                            }),
                          e.target.checked
                            ? "Shared with your organization."
                            : "Now private.",
                        )
                      }
                    />
                    <span>Share with my organization</span>
                  </label>
                  <button
                    type="button"
                    className="textButton"
                    onClick={() => {
                      if (!window.confirm(`Delete the view “${active.name}”?`))
                        return;
                      void run(
                        () => api(`views/${active.id}/delete`, {}),
                        "View deleted.",
                      ).then((ok) => {
                        if (ok) {
                          setCurrent("");
                          onApply(defaultView, {
                            status: "",
                            carrier_id: null,
                          });
                        }
                      });
                    }}
                  >
                    Delete view
                  </button>
                </>
              )}
              <button
                type="button"
                className="secondary"
                onClick={() => setSaving(true)}
              >
                Save as new view…
              </button>
            </div>
            {saving && (
              <form
                className="viewSave"
                aria-label="Save view"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const made = await api<{ id: string }>("views", {
                      name,
                      shared,
                      config: payload(),
                    });
                    setCurrent(made.id);
                    setSaving(false);
                    setName("");
                  }, "View saved.");
                }}
              >
                <label>
                  Name
                  <input
                    value={name}
                    maxLength={60}
                    required
                    autoFocus
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label className="setupCheckbox">
                  <input
                    type="checkbox"
                    checked={shared}
                    onChange={(e) => setShared(e.target.checked)}
                  />
                  <span>Share with my organization</span>
                </label>
                <div className="viewActions">
                  <button className="primary">Save view</button>
                  <button
                    type="button"
                    className="textButton"
                    onClick={() => setSaving(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </details>
      </div>
      <p className="srOnly" role="status">
        {status}
      </p>
      {error && (
        <span className="alert error" role="alert">
          {describe(error)}
        </span>
      )}
    </div>
  );
}

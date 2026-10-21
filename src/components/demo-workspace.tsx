"use client";
import Link from "next/link";
import { useState } from "react";
import { ApiContext } from "@/lib/client-api";
import { createDemoApi } from "@/lib/demo-api";
import Workspace from "./dispatch-workspace";
import { JoinWorkspace } from "./join-workspace";
export function DemoWorkspace({ joining = false }: { joining?: boolean }) {
  const [adapter] = useState(() => createDemoApi()),
    [generation, setGeneration] = useState(0);
  return (
    <ApiContext.Provider value={adapter.api}>
      <aside className="demoBanner" aria-label="Interactive demo">
        <div>
          <strong>Relay demo</strong>
          <span>
            Fictional sample data · changes stay on this device · no live
            services
          </span>
        </div>
        {!joining && (
          <div className="demoControls">
            <label>
              <span className="srOnly">Demo role</span>
              <select
                value={adapter.role}
                onChange={(e) => {
                  adapter.selectRole(
                    e.target.value as
                      | "dispatcher"
                      | "carrier-manager"
                      | "driver",
                  );
                  setGeneration((g) => g + 1);
                }}
              >
                <option value="dispatcher">Dispatcher view</option>
                <option value="carrier-manager">Carrier view</option>
                <option value="driver">Driver view</option>
              </select>
            </label>
            <button
              className="secondary"
              onClick={() => {
                adapter.reset();
                setGeneration((g) => g + 1);
              }}
            >
              Reset demo
            </button>
          </div>
        )}
        <Link href="/">Open Relay</Link>
      </aside>
      {joining ? <JoinWorkspace demo /> : <Workspace key={generation} demo />}
    </ApiContext.Provider>
  );
}

"use client";
import type { ReactNode } from "react";
import {
  BuildingsIcon,
  CheckCircleIcon,
  FileTextIcon,
  LockKeyIcon,
  UserIcon,
} from "@phosphor-icons/react/dist/ssr";
import { StatusBadge } from "@/components/ui/status-badge";
import { describe } from "@/lib/client-api";
import { formatDate as formatDateLong } from "@/lib/format";

/**
 * Pictures of the product's states for the explainer pages, drawn with the
 * same pills and wording the app uses (including its real refusal messages).
 * They are static; the interactive pieces are in mini-demos.tsx.
 */
function Visual({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="stepVisual shell appShell miniShell"
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  );
}
const Row = ({
  icon,
  name,
  children,
}: {
  icon: ReactNode;
  name: string;
  children: ReactNode;
}) => (
  <div className="miniRow">
    {icon}
    <span className="miniRowName">{name}</span>
    {children}
  </div>
);
const until = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return formatDateLong(d.toISOString());
};

/** A load cannot be booked without a verified agreement. */
export function AuthorizeVisual() {
  return (
    <Visual label="A verified carrier and a refused booking">
      <Row
        icon={<BuildingsIcon size={16} aria-hidden="true" />}
        name="Blue Ridge Transport"
      >
        <StatusBadge tone="good">Authorized until {until()}</StatusBadge>
      </Row>
      <Row
        icon={<BuildingsIcon size={16} aria-hidden="true" />}
        name="Prairie Line Logistics"
      >
        <StatusBadge tone="bad">No dispatch agreement</StatusBadge>
      </Row>
      <p className="miniMessage bad">
        New load for Prairie Line Logistics:{" "}
        {describe("CARRIER_AUTHORIZATION_REQUIRED")}
      </p>
    </Visual>
  );
}

/** A rate confirmation fills the form; a person checks it. */
export function CreateVisual() {
  const fields: [string, string][] = [
    ["Load reference", "RL-1048"],
    ["Agreed rate", "$2,500.00"],
    ["Pickup", "Chicago, IL"],
    ["Delivery", "Nashville, TN"],
  ];
  return (
    <Visual label="A form filled from a rate confirmation, waiting for a person to check it">
      <Row
        icon={<FileTextIcon size={16} aria-hidden="true" />}
        name="Rate confirmation read"
      >
        <StatusBadge tone="warn">Check each value</StatusBadge>
      </Row>
      <dl className="miniFields">
        {fields.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="miniCaption">
        Suggested by AI. The load exists only when a person creates it.
      </p>
    </Visual>
  );
}

/** Each load shows what paperwork is received, accepted or missing. */
export function PaperworkVisual() {
  return (
    <Visual label="Paperwork on one load">
      <Row
        icon={<FileTextIcon size={16} aria-hidden="true" />}
        name="Rate confirmation"
      >
        <StatusBadge tone="good">Accepted</StatusBadge>
      </Row>
      <Row
        icon={<FileTextIcon size={16} aria-hidden="true" />}
        name="Bill of lading"
      >
        <StatusBadge tone="warn">Awaiting review</StatusBadge>
      </Row>
      <Row
        icon={<FileTextIcon size={16} aria-hidden="true" />}
        name="Proof of delivery"
      >
        <StatusBadge tone="bad">Missing</StatusBadge>
      </Row>
    </Visual>
  );
}

export function RequestVisual() {
  return (
    <Visual label="The request form">
      <dl className="miniFields form">
        {["Your name", "Work email", "Dispatch company"].map((f) => (
          <div key={f}>
            <dt>{f}</dt>
            <dd className="miniInput">&nbsp;</dd>
          </div>
        ))}
      </dl>
      <span className="miniFakeButton">Request access</span>
    </Visual>
  );
}

export function ReviewVisual() {
  return (
    <Visual label="A request moving from pending to approved by a person">
      <Row icon={<UserIcon size={16} aria-hidden="true" />} name="Your request">
        <StatusBadge tone="warn">Waiting for a person</StatusBadge>
      </Row>
      <Row
        icon={<CheckCircleIcon size={16} aria-hidden="true" />}
        name="Reviewed by a person"
      >
        <StatusBadge tone="good">Approved, you are the owner</StatusBadge>
      </Row>
    </Visual>
  );
}

export function PasswordVisual() {
  return (
    <Visual label="Setting a password and turning on two-step verification">
      <Row icon={<LockKeyIcon size={16} aria-hidden="true" />} name="Password">
        <StatusBadge tone="good">Set with a single-use link</StatusBadge>
      </Row>
      <Row
        icon={<LockKeyIcon size={16} aria-hidden="true" />}
        name="Two-step verification"
      >
        <StatusBadge tone="good">On</StatusBadge>
      </Row>
    </Visual>
  );
}

export function CarriersVisual() {
  return (
    <Visual label="Carriers and their dispatch agreements">
      <Row
        icon={<BuildingsIcon size={16} aria-hidden="true" />}
        name="Blue Ridge Transport"
      >
        <StatusBadge tone="good">Authorized</StatusBadge>
      </Row>
      <Row
        icon={<BuildingsIcon size={16} aria-hidden="true" />}
        name="Prairie Line Logistics"
      >
        <StatusBadge tone="warn">Agreement awaiting review</StatusBadge>
      </Row>
    </Visual>
  );
}

export function InviteVisual() {
  return (
    <Visual label="People invited with a role, each seeing only their carriers">
      <Row icon={<UserIcon size={16} aria-hidden="true" />} name="Casey Lane">
        <StatusBadge>Carrier manager · Blue Ridge</StatusBadge>
      </Row>
      <Row icon={<UserIcon size={16} aria-hidden="true" />} name="Jordan Ellis">
        <StatusBadge>Driver · Blue Ridge</StatusBadge>
      </Row>
      <Row icon={<UserIcon size={16} aria-hidden="true" />} name="Morgan Reed">
        <StatusBadge>Driver · Prairie Line</StatusBadge>
      </Row>
    </Visual>
  );
}

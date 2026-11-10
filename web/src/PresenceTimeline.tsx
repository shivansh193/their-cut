import { useEffect, useMemo, useRef } from "react";
import { BryntumScheduler } from "@bryntum/scheduler-react-enterprise";
import { mmss } from "./api";

export interface Lane {
  id: string;
  name: string;
  color: string;
  pct: number;
  screen: { start: number; end: number; confidence?: number; evidence?: string }[];
  voice: { start: number; end: number; confidence?: number; evidence?: string }[];
  adjusted: boolean;
}

const BASE = new Date(2026, 0, 1, 0, 0, 0).getTime();
const at = (s: number) => new Date(BASE + Math.round(s * 1000));
const secs = (d: Date | string) => (new Date(d).getTime() - BASE) / 1000;

export default function PresenceTimeline(props: {
  duration: number;
  lanes: Lane[];
  playhead: number;
  revealT?: number; // when set, only paint up to this second (the "live" analysis effect)
  readOnly?: boolean;
  onSeek?: (s: number) => void;
  onEdit?: (childId: string, intervals: { start: number; end: number }[]) => void;
}) {
  const ref = useRef<BryntumScheduler>(null);
  const suppress = useRef(false);
  const pending = useRef<Set<string>>(new Set());
  const timer = useRef<number | undefined>(undefined);
  const cb = useRef(props);
  cb.current = props;

  const reveal = props.revealT ?? props.duration;
  const events = useMemo(() => {
    const out: any[] = [];
    for (const l of props.lanes) {
      const add = (kind: "screen" | "voice", xs: Lane["screen"]) =>
        xs.forEach((i, n) => {
          if (i.start >= reveal) return;
          out.push({
            id: `${l.id}-${kind}-${n}`,
            resourceId: l.id,
            startDate: at(i.start),
            endDate: at(Math.min(i.end, reveal)),
            name: kind === "screen" ? (l.adjusted ? "counted (adjusted)" : "on screen") : "narration",
            kind,
            evidence: i.evidence ?? "",
            confidence: i.confidence,
            eventColor: l.color,
            cls: kind === "voice" ? "tc-voice" : "",
            draggable: !props.readOnly,
            resizable: !props.readOnly,
          });
        });
      add("screen", l.screen);
      add("voice", l.voice);
    }
    return out;
  }, [props.lanes, reveal, props.readOnly]);

  const resources = useMemo(
    () => props.lanes.map((l) => ({ id: l.id, name: l.name, pct: l.pct, color: l.color })),
    [props.lanes],
  );

  // Programmatic data loads must not be mistaken for parent edits.
  useEffect(() => {
    suppress.current = true;
    const t = setTimeout(() => (suppress.current = false), 50);
    return () => clearTimeout(t);
  }, [events]);

  const flush = () => {
    const s = ref.current?.instance;
    if (!s) return;
    for (const childId of pending.current) {
      const ivs = (s.eventStore.records as any[])
        .filter((e) => e.resourceId === childId)
        .map((e) => ({ start: Math.max(0, secs(e.startDate)), end: Math.min(cb.current.duration, secs(e.endDate)) }))
        .filter((i) => i.end > i.start);
      cb.current.onEdit?.(childId, ivs);
    }
    pending.current.clear();
  };

  return (
    <div className="timeline">
      <BryntumScheduler
        ref={ref}
        startDate={at(0)}
        endDate={at(props.duration)}
        forceFit
        readOnly={props.readOnly}
        rowHeight={46}
        barMargin={4}
        resourceMargin={6}
        eventLayout="stack"
        eventStyle={"filled" as any}
        eventRenderer={() => ""}
        createEventOnDblClick={false}
        zoomOnMouseWheel={false}
        zoomOnTimeAxisDoubleClick={false}
        viewPreset={{
          base: "secondAndMinute",
          timeResolution: { unit: "second", increment: 1 },
          headers: [
            { unit: "second", increment: 10, renderer: (start: Date) => mmss(secs(start)) },
            { unit: "second", increment: 1, renderer: () => "" },
          ],
        } as any}
        columns={[
          {
            text: "Child",
            field: "name",
            width: 150,
            htmlEncode: false,
            renderer: ({ record }: any) =>
              `<div style="display:flex;align-items:center;gap:8px"><span style="width:10px;height:10px;border-radius:3px;background:${record.color}"></span><b>${record.name}</b><span style="margin-left:auto;font-variant-numeric:tabular-nums;color:#5c564e">${record.pct.toFixed(1)}%</span></div>`,
          },
        ]}
        resources={resources}
        events={events}
        timeRangesFeature={{ showCurrentTimeLine: false, showHeaderElements: true }}
        timeRanges={[{ id: "playhead", startDate: at(props.playhead), name: "", cls: "tc-playhead", style: "border-left:2px solid #2d2a26" }]}
        eventEditFeature={false}
        eventTooltipFeature={{
          template: ({ eventRecord }: any) =>
            `<b>${eventRecord.name}</b> · ${mmss(secs(eventRecord.startDate))}–${mmss(secs(eventRecord.endDate))}` +
            (eventRecord.confidence != null ? ` · confidence ${(eventRecord.confidence * 100).toFixed(0)}%` : "") +
            (eventRecord.evidence ? `<div style="max-width:320px;margin-top:4px">${String(eventRecord.evidence).replace(/</g, "&lt;")}</div>` : ""),
        }}
        eventDragFeature={{ constrainDragToResource: true }}
        eventMenuFeature={{
          items: {
            editEvent: false,
            copyEvent: false,
            cutEvent: false,
            splitEvent: false,
            unassignEvent: false,
            deleteEvent: { text: "Remove this segment" },
          },
        }}
        scheduleMenuFeature={{
          items: {
            addEvent: false,
            pasteEvent: false,
            markPresent: {
              text: "Mark present here (3 s)",
              icon: "fa fa-plus",
              weight: 1,
              onItem: ({ date, resourceRecord, source }: any) => {
                const s = source.eventStore;
                const t = Math.max(0, Math.min(cb.current.duration - 1, secs(date)));
                s.add({ resourceId: resourceRecord.id, startDate: at(t), endDate: at(Math.min(cb.current.duration, t + 3)), name: "added by parent", eventColor: resourceRecord.color, kind: "screen" });
              },
            },
          },
        }}
        onScheduleClick={({ date }: any) => cb.current.onSeek?.(Math.max(0, Math.min(cb.current.duration, secs(date))))}
        onEventClick={({ eventRecord }: any) => cb.current.onSeek?.(secs(eventRecord.startDate))}
        onDataChange={({ store, action, records, record }: any) => {
          if (suppress.current || props.readOnly) return;
          const s = ref.current?.instance;
          if (!s || store !== s.eventStore || !["update", "remove", "add"].includes(action)) return;
          for (const r of records ?? (record ? [record] : [])) if (r?.resourceId) pending.current.add(String(r.resourceId));
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(flush, 700);
        }}
      />
    </div>
  );
}

import { FoundryUI } from "../../foundry/FoundryUI";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAutomationQuery } from "./useAutomationQuery";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

export function ListFilters<State extends string>({
  environmentId,
  factoryId,
  onFactoryChange,
  state,
  states,
  onStateChange,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  onFactoryChange?: (value: string) => void;
  state: State;
  states: readonly State[];
  onStateChange: (value: State) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-4 rounded-lg border bg-muted/20 p-3">
      {onFactoryChange ? (
        <FactoryFilter environmentId={environmentId} value={factoryId} onChange={onFactoryChange} />
      ) : null}
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">State</p>
        <Select
          value={state}
          onValueChange={(value) => {
            if (value !== null) onStateChange(value);
          }}
        >
          <SelectTrigger aria-label="Filter by state">
            <SelectValue>{state.replaceAll("_", " ")}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {states.map((value) => (
              <SelectItem key={value} value={value}>
                {value.replaceAll("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function FactoryFilter({
  environmentId,
  value,
  onChange,
}: {
  environmentId: EnvironmentId;
  value: string;
  onChange: (value: string) => void;
}) {
  const query = useAutomationQuery(environmentId, { op: "factories", limit: 50 });
  const factories = query.result?.kind === "factories" ? query.result.items : [];
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">Factory</p>
      <Select
        value={value}
        onValueChange={(id) => {
          if (id !== null) onChange(id);
        }}
      >
        <SelectTrigger aria-label="Filter by factory">
          <SelectValue>
            {value
              ? (factories.find((factory) => factory.id === value)?.name ?? value)
              : "All factories"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">All factories</SelectItem>
          {factories.map((factory) => (
            <SelectItem key={factory.id} value={factory.id}>
              {factory.name}
            </SelectItem>
          ))}
          {value && !factories.some((factory) => factory.id === value) ? (
            <SelectItem value={value}>{value}</SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      {query.error || (query.result?.kind === "factories" && query.result.next) ? (
        <details className="text-xs text-muted-foreground">
          <FoundryUI.Summary className="cursor-pointer">
            Filter another factory by ID
          </FoundryUI.Summary>
          <div className="pt-2">
            <Input
              aria-label="Factory ID"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder="Factory ID"
            />
          </div>
          {query.error ? <p role="status">Factory names are unavailable. {query.error}</p> : null}
        </details>
      ) : null}
    </div>
  );
}

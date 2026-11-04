import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

export function ListFilters<State extends string>({
  factoryId,
  onFactoryChange,
  state,
  states,
  onStateChange,
}: {
  factoryId: string;
  onFactoryChange?: (value: string) => void;
  state: State;
  states: readonly State[];
  onStateChange: (value: State) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">Factory</span>
        <Input
          aria-label="Filter by factory"
          value={factoryId}
          onChange={(event) => onFactoryChange?.(event.target.value)}
          disabled={!onFactoryChange}
          placeholder="All factories"
        />
      </label>
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

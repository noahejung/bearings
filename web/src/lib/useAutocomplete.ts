import { useEffect, useRef, useState } from "react";
import { getAutocomplete } from "../api";
import type { AutocompleteResult } from "../types";

// LAYOUT-V3 WAVE 3 (2026-08-03, SPEC-layout-v3.md §5.1: "reuse [the
// debounced autocomplete]... don't build a second typeahead"). Extracted
// out of AddressSearch.tsx (which owned this exact debounce/generation-
// guard/suggestion-suppression state machine first, for the main search
// bar) so the add-destination field in the getting-around region (Wave 3)
// reuses the SAME machinery instead of a second, independently-drifting
// copy of it. AddressSearch.tsx itself is refactored to call this hook too
// -- behaviour is unchanged (this is a pure extraction, not a rewrite; see
// AddressSearch.test.tsx, which is untouched and still green).
const AUTOCOMPLETE_MIN_CHARS = 3;
const AUTOCOMPLETE_DEBOUNCE_MS = 300;

export interface UseAutocomplete {
  suggestions: AutocompleteResult[];
  suggestionsOpen: boolean;
  setSuggestionsOpen: (open: boolean) => void;
  /** Cancels whatever fetch is scheduled/in-flight, closes the dropdown, and
   * marks `consumedValue` so re-typing the exact same text (e.g. `value`
   * changing to the just-picked/submitted string, which re-triggers this
   * hook's own effect) doesn't reopen it. Call this from both "submit the
   * typed text" and "pick a suggestion" handlers -- see AddressSearch.tsx's
   * own comment for the two real, live-caught races this guards against. */
  suppress: (consumedValue: string) => void;
}

export function useAutocomplete(value: string): UseAutocomplete {
  const [suggestions, setSuggestions] = useState<AutocompleteResult[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  // Generation counter, not `AbortController` -- see AddressSearch.tsx's
  // original comment (api.ts's `request()` has no signal support to plug
  // one into). Only the LATEST keystroke's response is ever applied.
  const requestGenRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSubmittedRef = useRef<string | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = value.trim();
    if (trimmed.length < AUTOCOMPLETE_MIN_CHARS || trimmed === lastSubmittedRef.current) {
      setSuggestions([]);
      setSuggestionsOpen(false);
      return;
    }
    const gen = ++requestGenRef.current;
    debounceRef.current = setTimeout(() => {
      getAutocomplete(trimmed)
        .then((res) => {
          if (gen !== requestGenRef.current) return; // a newer keystroke already superseded this
          setSuggestions(res.results);
          setSuggestionsOpen(res.results.length > 0);
        })
        .catch(() => {
          // Non-fatal: a typeahead that can't reach the API just shows no
          // suggestions -- the form still works as a plain free-text submit.
          if (gen !== requestGenRef.current) return;
          setSuggestions([]);
          setSuggestionsOpen(false);
        });
    }, AUTOCOMPLETE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value]);

  function suppress(consumedValue: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    requestGenRef.current++;
    lastSubmittedRef.current = consumedValue;
    setSuggestionsOpen(false);
  }

  return { suggestions, suggestionsOpen, setSuggestionsOpen, suppress };
}

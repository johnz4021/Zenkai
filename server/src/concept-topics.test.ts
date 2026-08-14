import { describe, expect, it } from 'vitest';
import { filterExercised, gateConceptTopics } from './concept-topics.js';

describe('gateConceptTopics', () => {
  it('accepts slugs and derives labels', () => {
    const t = gateConceptTopics(['hash_map_indexing', 'two_pointer_scans', 'api_error_contracts', 'graph_traversal']);
    expect(t).toHaveLength(4);
    expect(t[0]).toEqual({ id: 'hash_map_indexing', label: 'hash map indexing' });
  });

  it('normalizes case and whitespace before gating', () => {
    const t = gateConceptTopics([' Hash_Map_Indexing ', 'two_pointer_scans', 'api_error_contracts', 'graph_traversal']);
    expect(t[0]!.id).toBe('hash_map_indexing');
  });

  it('throws on non-arrays', () => {
    expect(() => gateConceptTopics('graphs')).toThrow(/not an array/);
  });

  it('enforces the count band', () => {
    expect(() => gateConceptTopics(['a_b_c', 'd_e_f', 'g_h_i'])).toThrow(/need 4-12/);
    expect(() => gateConceptTopics(Array.from({ length: 13 }, (_, i) => `topic_${i}xx`))).toThrow(/need 4-12/);
  });

  it('rejects non-slug shapes with the offender named', () => {
    expect(() => gateConceptTopics(['Two-Pointers!', 'a_b_c', 'd_e_f', 'g_h_i'])).toThrow(/two-pointers!/);
  });

  it('rejects filler categories', () => {
    expect(() => gateConceptTopics(['misc', 'a_b_c', 'd_e_f', 'g_h_i'])).toThrow(/filler/);
  });

  it('rejects duplicates after normalization', () => {
    expect(() => gateConceptTopics(['a_b_c', 'A_B_C', 'd_e_f', 'g_h_i'])).toThrow(/duplicate/);
  });
});

describe('filterExercised', () => {
  const allowed = gateConceptTopics(['hash_map_indexing', 'two_pointer_scans', 'api_error_contracts', 'graph_traversal']);

  it('keeps the subset, drops inventions, and reports both', () => {
    const r = filterExercised(['hash_map_indexing', 'segment_trees'], allowed);
    expect(r.kept).toEqual(['hash_map_indexing']);
    expect(r.dropped).toEqual(['segment_trees']);
  });

  it('never throws on garbage — topics are annotation, not a gate', () => {
    expect(filterExercised(undefined, allowed)).toEqual({ kept: [], dropped: [] });
    expect(filterExercised('graphs', allowed)).toEqual({ kept: [], dropped: [] });
  });

  it('dedupes and case-normalizes declarations', () => {
    const r = filterExercised(['Hash_Map_Indexing', 'hash_map_indexing '], allowed);
    expect(r.kept).toEqual(['hash_map_indexing']);
  });
});

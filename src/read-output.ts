import { bound } from './safety.js';

// Tool presentation only: never apply these limits to polling or write preflights.
const fields = new Set(`id iid project_id title description state status detailed_merge_status draft web_url path name type mode sha ref source_branch target_branch source_project_id target_project_id created_at updated_at started_at finished_at merged_at closed_at duration queued_duration coverage failure_reason stage allow_failure author assignee assignees reviewers user username labels head_pipeline pipeline diff_refs base_sha head_sha start_sha merge_status merge_error merge_when_pipeline_succeeds blocking_discussions_resolved has_conflicts changes_count approved approved_by approvals_required approvals_left body notes individual_note resolvable resolved resolved_by system position old_path new_path new_file renamed_file deleted_file diff too_large collapsed content filename basename path_with_namespace startline data`.split(' '));

/** A byte budget plus structural limits keeps even hostile metadata out of context. */
export function readOutput(value: unknown, full = false, maxBytes = 60000): { data: unknown; output_truncated: boolean } {
    let budget = maxBytes, truncated = false;
    function visit(v: unknown, depth: number): unknown {
        if (budget <= 0 || depth > 10) { truncated = true; return null; }
        if (typeof v === 'string') {
            const out = bound(v, Math.max(0, Math.min(4000, budget)));
            budget -= Buffer.byteLength(JSON.stringify(out));
            if (out !== v) truncated = true;
            return out;
        }
        if (Array.isArray(v)) {
            const out = [];
            for (const item of v.slice(0, 100)) {
                if (budget < 32) break;
                budget -= 2; out.push(visit(item, depth + 1));
            }
            if (out.length !== v.length) truncated = true;
            return out;
        }
        if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [key, item] of Object.entries(v)) {
                if (!full && !fields.has(key)) continue;
                if (budget < Buffer.byteLength(key) + 10) { truncated = true; break; }
                budget -= Buffer.byteLength(key) + 4;
                out[key] = visit(item, depth + 1);
            }
            return out;
        }
        budget -= 20;
        return v;
    }
    const data = visit(value, 0);
    return { data, output_truncated: truncated };
}

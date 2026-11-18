import type { NormalizedEvent, User } from './types.js';
export const CORE_TAGS = [
    'chat:mention', 'chat:reply', 'chat:ambient', 'chat:from-human', 'chat:from-self', 'chat:thread', 'chat:edited', 'chat:has-link'
];
export function tagsFor(e: NormalizedEvent, self: User, maintainers: string[]) {
    // Regular users, never bot/agent-name filtering. Numeric identity only.
    const fromSelf = e.actor?.id === self.id;
    const metadata = {
        fromSelf, mentioned: !!e.mention, isOwnThread: !!e.own, isReplyToSelf: !!e.replyToSelf, isReviewRequested: e.todoAction === 'review_requested', isCiFailure: e.status === 'failed', isWatchedJob: e.kind === 'job.finished', isMaintainer: !!e.actor && maintainers.includes(e.actor.username), project: e.project, iid: e.thread?.number ?? null, actor: e.actor?.username ?? null, sha: e.sha ?? null, todoAction: e.todoAction ?? null
    };
    const tags = [...(e.actor ? [fromSelf ? 'chat:from-self' : 'chat:from-human'] : []), e.mention ? 'chat:mention' : e.replyToSelf ? 'chat:reply' : 'chat:ambient'];
    if (e.thread)
        tags.push('chat:thread');
    if (e.url)
        tags.push('chat:has-link');
    if (e.kind === 'comment.edited')
        tags.push('chat:edited');
    if (e.kind.startsWith('mr.'))
        tags.push(`gitlab:mr=${e.kind.slice(3).replaceAll('_', '-')}`);
    if (e.kind.startsWith('issue.'))
        tags.push(`gitlab:issue=${e.kind.slice(6)}`);
    if (e.todoAction)
        tags.push(`gitlab:todo=${e.todoAction}`);
    if (e.status)
        tags.push(`gitlab:ci=${e.status}`);
    if (e.interest)
        tags.push(`gitlab:pipeline=${e.interest}`);
    if (e.job)
        tags.push(`gitlab:job=${e.job}`);
    if (metadata.isMaintainer)
        tags.push('gitlab:actor=maintainer');
    if (e.kind === 'branch.moved')
        tags.push('gitlab:branch=moved');
    if (e.kind === 'token.expiring')
        tags.push('gitlab:token=expiring');
    return { tags, metadata };
}

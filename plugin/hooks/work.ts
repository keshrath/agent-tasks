// =============================================================================
// Which prompts ask for work, for the pipeline reminder. A prompt asks for work
// unless every sentence of it is something else: a question asking to know, a
// thanks, a git command, a note to remember, or too short to say. A go-ahead
// ("continue", "go ahead with it") starts work, so it counts. Words of courtesy
// or assent in front ("ok", "yes,", "please", "go ahead and") are read past, so
// "Yes, implement it" is work and "Can you add a reopen button?" is too, while
// "How does the sweep work?", "Can you explain…", "Do you know…", "Don't change
// anything…" and "…, any idea why" are not. What is answered in the chat is no work to
// track either: a haiku or a translation of a sentence, a list given, a quote, running
// the tests. Asking to know and then to do ("explain why it fails and then fix it") is
// work. Long prompts are work whatever their form.
// =============================================================================

const LONG = 200;
const SHORTEST_STATEMENT = 20;

const LEADING =
  /^(?:(?:ok(?:ay)?|yes|yeah|yep|sure|no|nope|alright|right|great|perfect|cool|nice|good|thanks|thank you|please|now|then|so|and|also|next|first|again|actually|hmm+|well)\b[\s,.!:;-]*|(?:go ahead and|let'?s|let us|i want you to|i need you to|i'?d like you to|we need to|you should|you can)\s+)+/i;

const VERBS =
  'go ahead|go on|carry on|proceed|add|implement|build|fix|refactor|rewrite|re-?write|create|write|change|update|remove|delete|rename|move|migrate|port|make|set up|setup|wire|integrate|replace|convert|ship|release|deploy|bump|upgrade|install|configure|extend|improve|optimi[sz]e|clean up|cleanup|split|merge|push|edit|modify|test|debug|patch|finish|redo|revert|rework|restructure|use|drop|introduce|enable|disable|hook up|draft|design|prototype|document|translate|run|start|do|apply|commit|continue|resolve|handle|support|adjust|tweak|polish|backport|forward-?port|generate|publish|scaffold';

const WORK_VERB = new RegExp(`^(?:${VERBS})\\b`, 'i');

const REQUEST = new RegExp(
  `^(?:can|could|would|will) you (?:please |also |now |just )*(?:${VERBS})\\b`,
  'i',
);

const ASKS_TO_KNOW =
  /^(?:what(?:'s| is| are)?|whats|why|how|when|where|who|which|whose|is|are|was|were|does|do you|do we|did|has|have|should|shall|would|will|can i|can we|could i|could we|is there|are there|explain|tell me|show me|give me|let me know|describe|summari[sz]e|list|check|look at|review|find|search|read|see|quote|repeat)\b/i;

/** Text answered in the chat, not work on anything: "write a haiku", "translate this sentence". */
const CHAT_ANSWER =
  /^(?:write|draft|compose|generate|make|create|translate|rephrase|reword)\s+(?:me\s+)?(?:a|an|the|this|that|some|my)?\s*(?:short\s+|quick\s+)?(?:haiku|poem|limerick|joke|story|song|riddle|tweet|sentence|phrase|word|paragraph|text|message|reply|email|letter|summary|tl;?dr)s?\b/i;

/** Running the checks reads the code, it changes nothing. */
const CHECKS_ONLY =
  /^run (?:the |all (?:the )?)?(?:tests?|test suite|unit tests|e2e(?: tests)?|lint(?:er)?|checks?|type-?check)(?: again)?[.!]?$/i;

/** Asking to know, in the form of a request or with a verb of work after it: read first. */
const ASKS_FIRST =
  /^(?:do you|do we|does|did|(?:can|could|would|will) you (?:please )?(?:explain|tell|show|describe|summari[sz]e|clarify|walk me through|help me understand|remind me))\b/i;

/** A sentence that says what not to do is no work to claim a task for. */
const NOT_TO_DO = /^(?:do not|don't|dont|never|no need to|stop|without)\b/i;

/** Words that make a statement a question: "the build fails, any idea why". */
const QUESTION_CUE = /\b(?:any idea|why|how come|wondering|what do you think|what you think)\b/i;

/** Work asked for after the question: "explain why it fails and then fix it". */
const THEN_WORK = new RegExp(`\\b(?:and|then)\\s+(?:then\\s+)?(?:${VERBS})\\b`, 'i');

const THANKS_OR_ASSENT =
  /^(?:that'?s|it'?s|this is|looks|sounds|seems|works|worked|perfect|great|good|nice|cool|awesome|thanks|thank you|got it|understood|makes sense|lgtm)\b/i;

const GIT_ONLY =
  /^(?:git )?(?:commit|push|pull|fetch|rebase|stash)(?: (?:it|this|that|them|everything|all|the changes|changes|now))?(?:,? (?:and|then) (?:commit|push|pull)(?: (?:it|this|that|them|everything|all))?)*[.!]?$/i;

const NOTE = /^(?:remember|forget|note that|keep in mind|save (?:this|that) (?:to|in) memory)\b/i;

const SYSTEM =
  /^\s*<(?:system-reminder|task-notification|local-command-caveat|command-name|command-message)>/i;

/** One sentence asks for work: see the file header. */
function asksForWork(sentence: string): boolean {
  const s = sentence.trim().replace(LEADING, '').trim();
  if (!s || NOT_TO_DO.test(s) || GIT_ONLY.test(s) || CHAT_ANSWER.test(s) || CHECKS_ONLY.test(s))
    return false;
  if (ASKS_FIRST.test(s)) return THEN_WORK.test(s);
  if (WORK_VERB.test(s) || REQUEST.test(s)) return true;
  if (ASKS_TO_KNOW.test(s) || THANKS_OR_ASSENT.test(s) || NOTE.test(s)) return false;
  if (/\?\s*$/.test(s) || QUESTION_CUE.test(s)) return false;
  return s.length >= SHORTEST_STATEMENT;
}

export function isWorkPrompt(text: string): boolean {
  const t = text.trim();
  if (!t || t.startsWith('/') || SYSTEM.test(t)) return false;
  if (t.length >= LONG) return true;

  return t.split(/(?<=[.!?;\n])\s+/).some(asksForWork);
}

export const PIPELINE_REMINDER =
  'PIPELINE REQUIRED: this session holds no claimed agent-tasks task.\n\n' +
  'Before doing this work, create a task with task_create or claim one with task_stage action "claim". ' +
  'Do NOT start writing code or making changes until this session has claimed a pipeline task.';

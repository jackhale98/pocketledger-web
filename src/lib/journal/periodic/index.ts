// Periodic transaction rules (`~ PERIOD  DESCRIPTION` + postings): find,
// parse, format, and plan minimal patches. Patches are the writer's Patch
// type and are applied with writer.apply; everything outside a rule's lines
// stays byte-identical, as with transactions (docs/WRITER.md).

export { isRuleHeader, ruleExtent, findRuleSpans, normalizeRuleSpan } from './spans';
export {
  parseRuleHeader,
  parseRuleLines,
  ruleFromText,
  rulesInFile,
  findRules,
  normalizePeriod,
  splitPeriod,
  composePeriod,
  periodDate,
  ruleCheckWindow,
  type RuleDraft,
  type PeriodicRule,
  type RuleHeader,
  type PeriodParts,
} from './parse';
export { formatRule, formatRuleHeader, validateRule, validateRuleHeader, assertValidRule, RuleError } from './format';
export { ruleStyle, locateRule, planEditRule, planReplaceRuleText, planDeleteRule, planAddRule, planAddRuleText, defaultRuleFile } from './plan';

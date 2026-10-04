/* eslint-disable @typescript-eslint/naming-convention */
import { BadRequestHttpError } from '../../util/errors/BadRequestHttpError';
import { isJsonObject } from '../../util/JsonMergePatch';
import { FOAF, LWS } from '../../util/Vocabularies';
import { AccessMode } from '../permissions/Permissions';

/**
 * The JSON-LD context of LWS documents.
 */
export const LWS_CONTEXT_URI = 'https://www.w3.org/ns/lws/v1';
/**
 * The identifier of the LWS Access Profile.
 */
export const LWS_ACCESS_PROFILE = `${LWS.namespace}AccessProfile`;

/**
 * A constraint of an access policy, based on the ODRL constraint model.
 */
export interface AccessConstraint {
  leftOperand: string;
  operator: string;
  rightOperand: unknown;
}

/**
 * An access policy of the LWS Access Profile.
 */
export interface AccessPolicy {
  type: string | string[];
  action: string[];
  assignee: string;
  target?: { type: string; value: string[] };
  constraint?: AccessConstraint[];
}

/**
 * An LWS access request or access grant.
 */
export interface AccessDocument {
  '@context': string | string[];
  type: string | string[];
  storage: string;
  inbox?: string;
  access: AccessPolicy[];
  [key: string]: unknown;
}

/**
 * The actions of the LWS Access Profile and the access modes they correspond to.
 * The `create` action is handled separately, as it applies to the members of a container.
 */
export const ACTION_MODES: Record<string, AccessMode[]> = {
  read: [ AccessMode.read ],
  modify: [ AccessMode.write, AccessMode.append ],
  create: [ AccessMode.append ],
  delete: [ AccessMode.delete ],
};

/**
 * The left operands of the LWS Access Profile.
 */
export const LEFT_OPERANDS = [ 'client', 'format', 'type', 'purpose', 'dateTime' ];

/**
 * The supported constraint operators.
 */
export const OPERATORS = [ 'eq', 'neq', 'isAnyOf', 'isNoneOf', 'lt', 'lteq', 'gt', 'gteq' ];

/**
 * The URI used as assignee to grant access to everyone.
 */
export const PUBLIC_ASSIGNEE = FOAF.Agent;

const DATE_OPERATORS = new Set([ 'eq', 'neq', 'lt', 'lteq', 'gt', 'gteq' ]);

const ABSOLUTE_URI = /^[a-z][\w+.-]*:\S+$/iu;

/**
 * Returns the values of a property that can be a single value or an array.
 */
export function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [ value ];
}

/**
 * Checks whether the given type value contains the given term, either as a term or as an LWS URI.
 */
export function hasType(value: unknown, term: string): boolean {
  return toArray(value).some((type): boolean => type === term || type === `${LWS.namespace}${term}`);
}

/**
 * Checks whether the given value is an absolute URI.
 */
export function isAbsoluteUri(value: unknown): value is string {
  return typeof value === 'string' && ABSOLUTE_URI.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry): boolean => typeof entry === 'string');
}

function invalid(message: string): never {
  throw new BadRequestHttpError(`Invalid access document: ${message}`);
}

/**
 * Validates a constraint of an access policy.
 */
function validateConstraint(constraint: unknown): void {
  if (!isJsonObject(constraint)) {
    invalid('a constraint needs to be an object.');
  }
  const { leftOperand, operator, rightOperand } = constraint;
  if (typeof leftOperand !== 'string' || !LEFT_OPERANDS.includes(leftOperand)) {
    invalid(`unsupported constraint left operand ${String(leftOperand)}.`);
  }
  if (typeof operator !== 'string' || !OPERATORS.includes(operator)) {
    invalid(`unsupported constraint operator ${String(operator)}.`);
  }
  if (rightOperand === undefined || rightOperand === null) {
    invalid('a constraint needs a right operand.');
  }
  if ((operator === 'isAnyOf' || operator === 'isNoneOf') && !isStringArray(rightOperand)) {
    invalid(`the ${operator} operator needs an array of strings as right operand.`);
  }
  const isDate = typeof rightOperand === 'string' && !Number.isNaN(Date.parse(rightOperand));
  if (leftOperand === 'dateTime' && (!DATE_OPERATORS.has(operator) || !isDate)) {
    invalid('a dateTime constraint needs a comparison operator and a dateTime value.');
  }
}

/**
 * Validates an access policy of the LWS Access Profile.
 */
function validatePolicy(policy: unknown, storage: string): void {
  if (!isJsonObject(policy)) {
    invalid('access needs to contain objects.');
  }
  if (!hasType(policy.type, 'AccessPolicy')) {
    invalid('an access policy needs the type AccessPolicy.');
  }
  if (!isStringArray(policy.action)) {
    invalid('an access policy needs an array of actions.');
  }
  for (const action of policy.action) {
    if (!Object.keys(ACTION_MODES).includes(action)) {
      invalid(`unsupported action ${action}.`);
    }
  }
  if (!isAbsoluteUri(policy.assignee)) {
    invalid('an access policy needs an assignee URI.');
  }
  if (policy.target !== undefined) {
    const { target } = policy;
    if (!isJsonObject(target) || typeof target.type !== 'string' || !isStringArray(target.value)) {
      invalid('a target needs to be an object with a type and an array of values.');
    }
    if (![ 'DataResource', 'Container', 'StorageResource' ].some((type): boolean => hasType(target.type, type))) {
      invalid(`unsupported target type ${target.type}.`);
    }
    for (const value of target.value) {
      if (!value.startsWith(storage)) {
        invalid(`the target ${value} is not part of the storage ${storage}.`);
      }
    }
  }
  if (policy.constraint !== undefined) {
    if (!Array.isArray(policy.constraint)) {
      invalid('constraint needs to be an array.');
    }
    for (const constraint of policy.constraint) {
      validateConstraint(constraint);
    }
  }
}

/**
 * Validates an LWS access request or access grant.
 * Throws a 400 error if the document is not valid.
 *
 * @param document - The parsed JSON document.
 * @param type - The type the document needs to have: `AccessRequest` or `AccessGrant`.
 * @param storage - The storage the document needs to be scoped to.
 */
export function validateAccessDocument(document: unknown, type: string, storage: string): AccessDocument {
  if (!isJsonObject(document)) {
    invalid('the document needs to be a JSON object.');
  }
  if (!toArray(document['@context']).includes(LWS_CONTEXT_URI)) {
    invalid(`the @context needs to include ${LWS_CONTEXT_URI}.`);
  }
  if (!hasType(document.type, type)) {
    invalid(`the document needs the type ${type}.`);
  }
  if (document.storage !== storage) {
    invalid(`the storage needs to be ${storage}.`);
  }
  if (document.inbox !== undefined && !isAbsoluteUri(document.inbox)) {
    invalid('the inbox needs to be a URI.');
  }
  if (!Array.isArray(document.access) || document.access.length === 0) {
    invalid('access needs to be a non-empty array.');
  }
  for (const policy of document.access) {
    validatePolicy(policy, storage);
  }
  return document as AccessDocument;
}

/**
 * The context in which the constraints of an access policy are evaluated.
 */
export interface ConstraintContext {
  /**
   * The client identifier of the request.
   */
  client?: string;
  /**
   * The current time.
   */
  now: Date;
  /**
   * Returns the media type of the target resource, if known.
   */
  getFormat: () => Promise<string | undefined>;
  /**
   * Returns the type URIs of the target resource.
   */
  getTypes: () => Promise<string[]>;
}

function compare(operator: string, actual: string[], expected: unknown): boolean {
  const values = toArray(expected as string | string[]);
  switch (operator) {
    case 'eq':
    case 'isAnyOf':
      return actual.some((value): boolean => values.includes(value));
    case 'neq':
    case 'isNoneOf':
      return !actual.some((value): boolean => values.includes(value));
    default:
      return false;
  }
}

function compareDates(operator: string, actual: Date, expected: string): boolean {
  const difference = actual.getTime() - Date.parse(expected);
  switch (operator) {
    case 'lt':
      return difference < 0;
    case 'lteq':
      return difference <= 0;
    case 'gt':
      return difference > 0;
    case 'gteq':
      return difference >= 0;
    case 'eq':
      return difference === 0;
    default:
      return difference !== 0;
  }
}

/**
 * Evaluates a single constraint.
 *
 * Purpose constraints are always considered to be satisfied:
 * the purpose is a statement of intent by the requesting agent which the server can not verify.
 */
export async function isConstraintSatisfied(constraint: AccessConstraint, context: ConstraintContext):
Promise<boolean> {
  const { leftOperand, operator, rightOperand } = constraint;
  switch (leftOperand) {
    case 'client':
      return compare(operator, context.client ? [ context.client ] : [], rightOperand);
    case 'format': {
      const format = await context.getFormat();
      return compare(operator, format ? [ format ] : [], rightOperand);
    }
    case 'type':
      return compare(operator, await context.getTypes(), rightOperand);
    case 'dateTime':
      return compareDates(operator, context.now, rightOperand as string);
    case 'purpose':
      return true;
    default:
      return false;
  }
}

/**
 * Evaluates all constraints of an access policy. All of them need to be satisfied.
 */
export async function areConstraintsSatisfied(policy: AccessPolicy, context: ConstraintContext): Promise<boolean> {
  for (const constraint of policy.constraint ?? []) {
    if (!await isConstraintSatisfied(constraint, context)) {
      return false;
    }
  }
  return true;
}

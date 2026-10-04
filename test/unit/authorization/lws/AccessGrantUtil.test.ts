import type {
  AccessConstraint,
  AccessPolicy,
  ConstraintContext,
} from '../../../../src/authorization/lws/AccessGrantUtil';
import {
  areConstraintsSatisfied,
  hasType,
  isAbsoluteUri,
  isConstraintSatisfied,
  LWS_CONTEXT_URI,
  PUBLIC_ASSIGNEE,
  toArray,
  validateAccessDocument,
} from '../../../../src/authorization/lws/AccessGrantUtil';
import { BadRequestHttpError } from '../../../../src/util/errors/BadRequestHttpError';
import { FOAF, LWS } from '../../../../src/util/Vocabularies';

describe('AccessGrantUtil', (): void => {
  describe('#toArray', (): void => {
    it('converts values to arrays.', async(): Promise<void> => {
      expect(toArray(undefined)).toEqual([]);
      expect(toArray('a')).toEqual([ 'a' ]);
      expect(toArray([ 'a', 'b' ])).toEqual([ 'a', 'b' ]);
    });
  });

  describe('#hasType', (): void => {
    it('accepts terms and LWS URIs.', async(): Promise<void> => {
      expect(hasType('Container', 'Container')).toBe(true);
      expect(hasType(LWS.Container, 'Container')).toBe(true);
      expect(hasType([ 'Other', 'Container' ], 'Container')).toBe(true);
      expect(hasType('DataResource', 'Container')).toBe(false);
      expect(hasType(undefined, 'Container')).toBe(false);
    });
  });

  describe('#isAbsoluteUri', (): void => {
    it('accepts absolute URIs only.', async(): Promise<void> => {
      expect(isAbsoluteUri('http://example.com/')).toBe(true);
      expect(isAbsoluteUri('urn:uuid:123')).toBe(true);
      expect(isAbsoluteUri('/relative')).toBe(false);
      expect(isAbsoluteUri('http://example.com/ space')).toBe(false);
      expect(isAbsoluteUri(5)).toBe(false);
    });
  });

  it('uses foaf:Agent as public assignee.', async(): Promise<void> => {
    expect(PUBLIC_ASSIGNEE).toBe(FOAF.Agent);
  });

  describe('#validateAccessDocument', (): void => {
    const storage = 'http://example.com/alice/';
    let policy: Record<string, any>;
    let document: Record<string, any>;

    beforeEach(async(): Promise<void> => {
      policy = {
        type: 'AccessPolicy',
        action: [ 'read', 'modify', 'create', 'delete' ],
        assignee: 'http://example.com/bob/profile#me',
        target: { type: 'Container', value: [ `${storage}foo/` ]},
        constraint: [
          { leftOperand: 'client', operator: 'eq', rightOperand: 'http://client.example/' },
          { leftOperand: 'format', operator: 'isAnyOf', rightOperand: [ 'text/turtle' ]},
          { leftOperand: 'dateTime', operator: 'lt', rightOperand: '2030-01-01T00:00:00Z' },
        ],
      };
      document = {
        '@context': [ LWS_CONTEXT_URI ],
        type: 'AccessGrant',
        storage,
        inbox: 'http://example.com/bob/inbox/',
        access: [ policy ],
      };
    });

    function expectInvalid(message: string): void {
      let error: unknown;
      try {
        validateAccessDocument(document, 'AccessGrant', storage);
      } catch (err: unknown) {
        error = err;
      }
      expect(BadRequestHttpError.isInstance(error)).toBe(true);
      expect((error as Error).message).toBe(`Invalid access document: ${message}`);
    }

    it('returns valid documents.', async(): Promise<void> => {
      expect(validateAccessDocument(document, 'AccessGrant', storage)).toBe(document);
    });

    it('accepts minimal documents with LWS URIs as types.', async(): Promise<void> => {
      document = {
        '@context': LWS_CONTEXT_URI,
        type: `${LWS.namespace}AccessRequest`,
        storage,
        access: [{
          type: [ `${LWS.namespace}AccessPolicy` ],
          action: [ 'read' ],
          assignee: FOAF.Agent,
        }],
      };
      expect(validateAccessDocument(document, 'AccessRequest', storage)).toBe(document);
    });

    it('accepts all target types.', async(): Promise<void> => {
      for (const type of [ 'DataResource', 'StorageResource', LWS.Container ]) {
        policy.target.type = type;
        expect(validateAccessDocument(document, 'AccessGrant', storage)).toBe(document);
      }
    });

    it('rejects documents that are not objects.', async(): Promise<void> => {
      document = [] as any;
      expectInvalid('the document needs to be a JSON object.');
    });

    it('rejects documents with the wrong context.', async(): Promise<void> => {
      document['@context'] = 'http://example.com/context';
      expectInvalid(`the @context needs to include ${LWS_CONTEXT_URI}.`);
    });

    it('rejects documents with the wrong type.', async(): Promise<void> => {
      document.type = 'AccessRequest';
      expectInvalid('the document needs the type AccessGrant.');
    });

    it('rejects documents with the wrong storage.', async(): Promise<void> => {
      document.storage = 'http://example.com/bob/';
      expectInvalid(`the storage needs to be ${storage}.`);
    });

    it('rejects documents with an invalid inbox.', async(): Promise<void> => {
      document.inbox = 'inbox';
      expectInvalid('the inbox needs to be a URI.');
    });

    it('rejects documents without access.', async(): Promise<void> => {
      document.access = [];
      expectInvalid('access needs to be a non-empty array.');
      document.access = policy;
      expectInvalid('access needs to be a non-empty array.');
    });

    it('rejects policies that are not objects.', async(): Promise<void> => {
      document.access = [ 'policy' ];
      expectInvalid('access needs to contain objects.');
    });

    it('rejects policies with the wrong type.', async(): Promise<void> => {
      policy.type = 'Policy';
      expectInvalid('an access policy needs the type AccessPolicy.');
    });

    it('rejects policies with invalid actions.', async(): Promise<void> => {
      policy.action = 'read';
      expectInvalid('an access policy needs an array of actions.');
      policy.action = [];
      expectInvalid('an access policy needs an array of actions.');
      policy.action = [ 'read', 5 ];
      expectInvalid('an access policy needs an array of actions.');
      policy.action = [ 'read', 'control' ];
      expectInvalid('unsupported action control.');
      policy.action = [ 'toString' ];
      expectInvalid('unsupported action toString.');
    });

    it('rejects policies without an assignee URI.', async(): Promise<void> => {
      delete policy.assignee;
      expectInvalid('an access policy needs an assignee URI.');
    });

    it('rejects invalid targets.', async(): Promise<void> => {
      const message = 'a target needs to be an object with a type and an array of values.';
      policy.target = 'target';
      expectInvalid(message);
      policy.target = { type: [ 'Container' ], value: [ `${storage}foo/` ]};
      expectInvalid(message);
      policy.target = { type: 'Container', value: `${storage}foo/` };
      expectInvalid(message);
    });

    it('rejects unsupported target types.', async(): Promise<void> => {
      policy.target.type = 'Resource';
      expectInvalid('unsupported target type Resource.');
    });

    it('rejects targets outside the storage.', async(): Promise<void> => {
      policy.target.value.push('http://example.com/bob/');
      expectInvalid(`the target http://example.com/bob/ is not part of the storage ${storage}.`);
    });

    it('rejects constraints that are not an array.', async(): Promise<void> => {
      policy.constraint = {};
      expectInvalid('constraint needs to be an array.');
    });

    it('rejects invalid constraints.', async(): Promise<void> => {
      policy.constraint = [ 'constraint' ];
      expectInvalid('a constraint needs to be an object.');

      policy.constraint = [{ leftOperand: 'spatial', operator: 'eq', rightOperand: 'x' }];
      expectInvalid('unsupported constraint left operand spatial.');
      policy.constraint = [{ operator: 'eq', rightOperand: 'x' }];
      expectInvalid('unsupported constraint left operand undefined.');

      policy.constraint = [{ leftOperand: 'client', operator: 'hasPart', rightOperand: 'x' }];
      expectInvalid('unsupported constraint operator hasPart.');
      policy.constraint = [{ leftOperand: 'client', operator: 5, rightOperand: 'x' }];
      expectInvalid('unsupported constraint operator 5.');

      policy.constraint = [{ leftOperand: 'client', operator: 'eq' }];
      expectInvalid('a constraint needs a right operand.');
      policy.constraint = [{ leftOperand: 'client', operator: 'eq', rightOperand: null }];
      expectInvalid('a constraint needs a right operand.');
    });

    it('requires an array of strings for the set operators.', async(): Promise<void> => {
      policy.constraint = [{ leftOperand: 'type', operator: 'isAnyOf', rightOperand: 'x' }];
      expectInvalid('the isAnyOf operator needs an array of strings as right operand.');
      policy.constraint = [{ leftOperand: 'type', operator: 'isNoneOf', rightOperand: []}];
      expectInvalid('the isNoneOf operator needs an array of strings as right operand.');
    });

    it('requires a comparison operator and a date for dateTime constraints.', async(): Promise<void> => {
      const message = 'a dateTime constraint needs a comparison operator and a dateTime value.';
      policy.constraint = [{ leftOperand: 'dateTime', operator: 'isAnyOf', rightOperand: [ '2030-01-01' ]}];
      expectInvalid(message);
      policy.constraint = [{ leftOperand: 'dateTime', operator: 'gt', rightOperand: 'tomorrow' }];
      expectInvalid(message);
      policy.constraint = [{ leftOperand: 'dateTime', operator: 'gt', rightOperand: 5 }];
      expectInvalid(message);
    });
  });

  describe('#isConstraintSatisfied', (): void => {
    let context: ConstraintContext;

    beforeEach(async(): Promise<void> => {
      context = {
        client: 'http://client.example/',
        now: new Date('2025-01-01T00:00:00Z'),
        getFormat: jest.fn().mockResolvedValue('text/turtle'),
        getTypes: jest.fn().mockResolvedValue([ LWS.DataResource, 'http://example.com/Type' ]),
      };
    });

    async function check(leftOperand: string, operator: string, rightOperand: unknown): Promise<boolean> {
      return isConstraintSatisfied({ leftOperand, operator, rightOperand }, context);
    }

    it('compares the client.', async(): Promise<void> => {
      await expect(check('client', 'eq', 'http://client.example/')).resolves.toBe(true);
      await expect(check('client', 'eq', 'http://other.example/')).resolves.toBe(false);
      await expect(check('client', 'neq', 'http://other.example/')).resolves.toBe(true);
      await expect(check('client', 'neq', 'http://client.example/')).resolves.toBe(false);
      await expect(check('client', 'isAnyOf', [ 'a', 'http://client.example/' ])).resolves.toBe(true);
      await expect(check('client', 'isNoneOf', [ 'a', 'http://client.example/' ])).resolves.toBe(false);
      await expect(check('client', 'lt', 'http://client.example/')).resolves.toBe(false);
    });

    it('treats a missing client as no value.', async(): Promise<void> => {
      delete context.client;
      await expect(check('client', 'eq', 'http://client.example/')).resolves.toBe(false);
      await expect(check('client', 'neq', 'http://client.example/')).resolves.toBe(true);
    });

    it('compares the format.', async(): Promise<void> => {
      await expect(check('format', 'eq', 'text/turtle')).resolves.toBe(true);
      await expect(check('format', 'isNoneOf', [ 'text/turtle' ])).resolves.toBe(false);
      jest.mocked(context.getFormat).mockResolvedValue(undefined);
      await expect(check('format', 'eq', 'text/turtle')).resolves.toBe(false);
      await expect(check('format', 'isNoneOf', [ 'text/turtle' ])).resolves.toBe(true);
    });

    it('compares the types.', async(): Promise<void> => {
      await expect(check('type', 'isAnyOf', [ 'http://example.com/Type' ])).resolves.toBe(true);
      await expect(check('type', 'eq', LWS.Container)).resolves.toBe(false);
      await expect(check('type', 'isNoneOf', [ LWS.Container ])).resolves.toBe(true);
    });

    it('compares the time.', async(): Promise<void> => {
      const before = '2024-01-01T00:00:00Z';
      const now = '2025-01-01T00:00:00Z';
      const after = '2026-01-01T00:00:00Z';
      await expect(check('dateTime', 'lt', after)).resolves.toBe(true);
      await expect(check('dateTime', 'lt', now)).resolves.toBe(false);
      await expect(check('dateTime', 'lteq', now)).resolves.toBe(true);
      await expect(check('dateTime', 'lteq', before)).resolves.toBe(false);
      await expect(check('dateTime', 'gt', before)).resolves.toBe(true);
      await expect(check('dateTime', 'gt', now)).resolves.toBe(false);
      await expect(check('dateTime', 'gteq', now)).resolves.toBe(true);
      await expect(check('dateTime', 'gteq', after)).resolves.toBe(false);
      await expect(check('dateTime', 'eq', now)).resolves.toBe(true);
      await expect(check('dateTime', 'eq', after)).resolves.toBe(false);
      await expect(check('dateTime', 'neq', after)).resolves.toBe(true);
      await expect(check('dateTime', 'neq', now)).resolves.toBe(false);
    });

    it('always accepts purpose constraints.', async(): Promise<void> => {
      await expect(check('purpose', 'eq', 'http://example.com/purpose')).resolves.toBe(true);
    });

    it('rejects unknown left operands.', async(): Promise<void> => {
      await expect(check('spatial', 'eq', 'x')).resolves.toBe(false);
    });
  });

  describe('#areConstraintsSatisfied', (): void => {
    const context: ConstraintContext = {
      client: 'http://client.example/',
      now: new Date(),
      getFormat: jest.fn(),
      getTypes: jest.fn(),
    };
    const accept: AccessConstraint = { leftOperand: 'purpose', operator: 'eq', rightOperand: 'x' };
    const reject: AccessConstraint = { leftOperand: 'client', operator: 'neq', rightOperand: 'http://client.example/' };
    let policy: AccessPolicy;

    beforeEach(async(): Promise<void> => {
      policy = { type: 'AccessPolicy', action: [ 'read' ], assignee: FOAF.Agent };
    });

    it('accepts policies without constraints.', async(): Promise<void> => {
      await expect(areConstraintsSatisfied(policy, context)).resolves.toBe(true);
    });

    it('requires all constraints to be satisfied.', async(): Promise<void> => {
      policy.constraint = [ accept, accept ];
      await expect(areConstraintsSatisfied(policy, context)).resolves.toBe(true);
      policy.constraint = [ accept, reject ];
      await expect(areConstraintsSatisfied(policy, context)).resolves.toBe(false);
    });
  });
});

# Linked Web Storage

The server can be configured to serve the [Linked Web Storage](https://w3c.github.io/lws-protocol/lws10-core/) (LWS)
protocol, a W3C draft that builds on the ideas of the Solid Protocol.
The implementation follows the LWS editor's draft of 28 September 2026.
As LWS is still a draft, the behaviour described here may change along with the specification.

## Configurations

There are four configurations that enable LWS.
All of them store data on disk and allow the creation of accounts and pods, just like `file.json`.

| Configuration        | Protocols    | Authorization |
|----------------------|--------------|---------------|
| `lws.json`           | LWS          | WAC           |
| `lws-acp.json`       | LWS          | ACP           |
| `solid-lws.json`     | Solid + LWS  | WAC           |
| `solid-lws-acp.json` | Solid + LWS  | ACP           |

For example, to start an LWS server on port 3000 that stores its data in the `data` folder:

```shell
npx @solid/community-server -c @css:config/lws.json -f data/
```

Every pod is an LWS storage. In the dual configurations, Solid and LWS clients can work with the same pods.

## Storages and discovery

The URI of a storage is the URI of the root container of the pod.
Every response contains a `Link` header with relation `https://www.w3.org/ns/lws#storage` pointing to the storage.

A `GET` request to the storage URI with an `Accept` header that prefers `application/lws+cid`,
or without an `Accept` header, returns the storage description.
Other requests return the root container.
In the LWS-only configurations, a request that only accepts `*/*` also receives the storage description;
in the dual configurations it receives the root container, as Solid clients expect.
The storage description is public, so clients can discover the services of a storage without credentials.

## Containers and resources

Containers are represented as `application/lws+json`.
In the LWS-only configurations, `application/ld+json` and `application/json` return the same document.
In the dual configurations, `application/ld+json` keeps returning the LDP representation that Solid clients expect,
so LWS clients need to request `application/lws+json` or `application/json`.

Containers can be created with a `POST` or `PUT` request
that has a `Link: <https://www.w3.org/ns/lws#Container>; rel="type"` header,
next to the LDP container types.

Responses contain the `up`, `type`, and `linkset` links required by LWS,
and successful modifications return `204 No Content`.
JSON resources can be modified with [JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7386) requests.

## Linksets

The metadata of a resource is exposed as a [linkset](https://www.rfc-editor.org/rfc/rfc9264),
linked from the resource with `rel="linkset"`.
This is the same resource as the [description resource](metadata.md) of the resource,
which can be requested as `application/linkset+json`,
and modified with a JSON Merge Patch request on that linkset.
Server-managed links, such as the containment triples, can not be modified.

## Authorization

The server contains an LWS authorization server.
Its metadata can be found at `/.well-known/lws-configuration`.
A `401` response contains a `WWW-Authenticate` header with an `as_uri` parameter pointing to it,
and a `realm` parameter with the storage URI.

Clients obtain an access token by exchanging an authentication credential at the token endpoint
using [OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693),
with the storage URI as `resource` parameter.
The following authentication suites are supported:

* Self-signed `did:key` credentials (`urn:ietf:params:oauth:token-type:jwt`).
* Self-issued credentials of agents with an HTTPS identifier,
  whose controlled identifier document contains the verification key (`urn:ietf:params:oauth:token-type:jwt`).
* Self-issued credentials of agents with a [`did:web`](https://w3c-ccg.github.io/did-method-web/) identifier,
  whose DID document contains the verification key (`urn:ietf:params:oauth:token-type:jwt`).
  The document is retrieved from `https://<host>/.well-known/did.json`,
  or from `https://<host>/<path>/did.json` for identifiers with a path.
  The agent of such a credential keeps its `did:web` identifier:
  it is not automatically equivalent to a WebID or another identifier of the same agent.
* OpenID Connect ID tokens (`urn:ietf:params:oauth:token-type:id_token`).
  The controlled identifier document of the subject needs to contain an `https://www.w3.org/ns/lws#OpenIdProvider` service
  pointing to the issuer.
  WebIDs with a `solid:oidcIssuer` triple are also accepted,
  so the accounts of the identity provider of this server, and of other Solid identity providers, can be used.

The resulting access tokens are presented as `Bearer` tokens.
The agent in the access token is used as the WebID in WAC and ACP policies,
so access can be granted to a `did:key` or `did:web` identifier the same way as to a WebID.

In the dual configurations, Solid-OIDC DPoP and Bearer tokens are also accepted.
Bearer tokens that have a `webid` claim are treated as Solid-OIDC tokens.

## Pagination

Container listings with more than 1000 members are split into pages.
Every page has `first` and `last` links, and `prev` and `next` links where applicable.
The page URIs have a `page` query parameter, but clients should only follow the links.
The `items` of a page only contain the members on that page, while `totalItems` is the number of all members.
The page size can be changed with the `options_pageSize` parameter of the `ContainerToLwsJsonConverter`
in `config/util/representation-conversion/converters/lws-container.json`.

## Recursive deletes

A `DELETE` request with a `Depth: infinity` header deletes a container together with all resources in it.
This requires the `delete` permission on all those resources.
The deletion is not atomic: if a resource can not be deleted, the resources deleted before it stay deleted.

## Errors

Errors are described with [problem details](https://www.rfc-editor.org/rfc/rfc9457) (`application/problem+json`),
unless the client prefers a media type the error can be converted to, such as HTML or Turtle.

## Access requests and grants

Every storage has an access request container at `.lws/requests/`
and an access grant container at `.lws/grants/`, relative to the storage URI.
Both are advertised in the storage description with the `https://www.w3.org/ns/lws#AccessProfile` profile.
The containers are created when the first request for a resource in the storage arrives.

* Any authenticated agent can create an access request by posting it to the access request container.
* Access grants are created by posting them to the access grant container.
  They grant access next to the WAC or ACP policies, so a grant can only add permissions.
  Deleting a grant revokes it.
* The containers themselves are protected by the WAC or ACP policies of the storage,
  so by default only the owner of the storage can read the requests and create grants.
  Make sure the policies of the `.lws/` container do not give other agents access to these containers.

The posted documents are validated against the Access Profile of LWS,
and can not be modified afterwards: only `GET`, `HEAD`, and `DELETE` are allowed on them.

The policies of a grant are interpreted as follows:

* The `assignee` is compared with the WebID or other identifier of the agent.
  `http://xmlns.com/foaf/0.1/Agent` grants access to everyone, including unauthenticated agents.
* A policy only applies to the resources listed in its `target`, so targets are not recursive.
  The target `type` limits the resources to containers (`Container`), data resources (`DataResource`),
  or both (`StorageResource`). A policy without a target does not grant anything.
  Grants can not target the `.lws/` container or its contents.
* The `read`, `modify`, and `delete` actions correspond to reading, modifying, and deleting the target.
  The `create` action on a container allows creating resources directly in that container.
* All constraints need to be satisfied: `client` is compared with the client identifier of the request,
  `format` with the media type of the resource, `type` with its types, and `dateTime` with the current time.
  `purpose` constraints are always considered to be satisfied,
  as the server can not verify the purpose of a request.

When a grant with an `inbox` is created, a notification is sent to that inbox.
The grants are cached in memory, so this feature does not work on a server with multiple worker threads.

## Notifications

The server supports the [LWS Webhook notification suite](https://w3c.github.io/lws-protocol/lws10-notifications-webhook/).
Its subscription endpoint is `/.notifications/lws/`, which is advertised in the storage description.

* A `POST` request with a `WebhookSubscription` creates a subscription,
  if the subscriber can read all resources in its `topic` array.
  Subscriptions to a container also cover all resources contained in it, recursively.
* A `GET` request on the endpoint lists the subscriptions of the authenticated subscriber,
  and a subscription can be read and deleted by its subscriber.
* Notifications about creating, updating, and deleting resources are sent to the `inbox` of the subscription,
  but only if the subscriber can still read the resource when the change happens.
  The notifications do not contain the agent that made the change.
* Notifications are signed with [HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421).
  The key is in the `verificationMethod` of the storage description.
* Deliveries that fail with a `5xx` response or a network error are tried again twice.
  Subscriptions are removed after 5 failed deliveries in a row, or when the inbox answers with `410 Gone`.

Like the access grants, the subscriptions are cached in memory,
so this feature does not work on a server with multiple worker threads.
The Solid notification channels remain available next to the LWS notifications.

## Not supported

The following parts of LWS are not supported yet:

* Notifications to the storage controller when an access request is created,
  as LWS does not define how the inbox of the storage controller is found.
* The SAML authentication suite.

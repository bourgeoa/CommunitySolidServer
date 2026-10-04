# LDP

Options related to the Linked Data Platform implementation.
This is the core part of the Solid server.

## Authentication

Covers how agents are identified.

* *debug-auth-header*: Allows authentication headers such as `WebID http://test.com/card#me`
  to identify as that WebID without further checks.
* *debug-test-agent*: Always assumes the agent is the set identifier.
* *dpop-bearer*: Uses the default DPoP and Bearer identification.
* *lws*: Only accepts Linked Web Storage access tokens, issued by the LWS authorization server.
  Requests with an invalid token receive a 401 response with an `invalid_token` error.
* *solid-lws*: Accepts Linked Web Storage access tokens and Solid-OIDC DPoP and Bearer tokens.

## Authorization

Covers how operations are authorized (or rejected).

* *acp*: Use Access Control Policy.
* *allow-all*: No authorization, everything is allowed.
* *webacl*: Use Web Access Control.

## Handler

Contains the default LDP handler that will handle most requests.

* *default*: The default setup.
  Some identifiers seen here are defined by the other options found in this document.
* *lws*: Also serves the Linked Web Storage storage description on the storage root,
  and returns 204 instead of 205 after successful modifications.
* *solid-lws*: Same as *lws*, but Solid clients keep receiving the root container
  when they do not explicitly request the storage description.

## Metadata-Parser

Contains a list of parsers that will be run on incoming requests to generate metadata.

* *default*: Contains the default parsers. Can be added to when specific parsers are required.
* *lws*: Also interprets `Link: <https://www.w3.org/ns/lws#Container>; rel="type"` as a request to create a container.

## Metadata-Writer

Contains a list of metadata writers that will be run on outgoing responses.

* *default*: Contains the default writers. Can be added to when specific parsers are required.
* *lws*: Also adds the Link headers and the `WWW-Authenticate` challenge required by Linked Web Storage.
* *solid-lws*: Same as *lws*, but the `WWW-Authenticate` challenge also contains the Solid `scope` parameter.

## Modes

Determines which modes are needed for requests,
by default this is based on the used HTTP method.

* *default*: Bases required modes on HTTP method.
* *lws*: Same as *default*, but also supports JSON Merge Patch requests.

# Util

Various utility related options.

## Auxiliary

Exports an object that contains a list of all auxiliary resources that need to be supported.
In case you create a new auxiliary strategy you can just add it to this list.

* *acl*: Default list with only support for acl auxiliary resources.
* *acp*: Default list with only support for acr auxiliary resources.
* *empty*: An empty list which can be added to.

## Identifiers

How identifiers should be interpreted.
This is mostly relevant when creating pods and/or using a file-based backend.

* *subdomain*: New pod identifier would be `http://alice.test.com/`.
  File path of `http://alice.test.com/foo` would be `/alice/foo`.
* *suffix*: New pod identifier would be `http://test.com/alice`.
  Requests to subdomain identifiers would be rejected.

## Index

This can be used to provide different behaviour for index files.
This is mostly relevant for user interfaces.

* *default*: No special support.
* *example*: An example of how this could be configured.
  If this is needed the best solution is usually to not import anything here
  and have the index setup in the root config.

## Logging

Which logger to use.

* *no-logging*: Disables all logging.
* *winston*: Uses the winston logger.

## Representation-conversion

Used for converting from one content type to another when needed.
When a new content type needs to be supported, this can be done by adding a corresponding converter
to the ChainedConverter list.

* *default*: The default conversion setup which supports most RDF formats.
* *lws*: Also supports the Linked Web Storage container representation (`application/lws+json`),
  which is also returned for `application/ld+json` and `application/json` requests on containers,
  and the `application/linkset+json` representation of metadata resources.
* *solid-lws*: Same as *lws*, but containers are only represented as `application/lws+json`
  when that media type, or `application/json`, is explicitly requested.
  Solid clients requesting `application/ld+json` keep receiving the LDP representation.

## Resource-locker

Which locking mechanism to use to for example prevent 2 write simultaneous write requests.

* *debug-void*: No locking mechanism, does not prevent simultaneous read/writes.
* *file*: Uses a file-system based locking mechanism (process-safe/thread-safe).
* *file-capped*: Uses the file-system locker with a one-hour maximum hold duration.
* *memory*: Uses an in-memory locking mechanism.
* *redis*: Uses a Redis store for locking that supports threadsafe read-write locking (process-safe/thread-safe).

## Variables

Various variables used by other options.
These can usually be set through CLI parameters.

* *default*: The default list of variables.

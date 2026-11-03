# ADR 0002: Foundation catalog ownership and grants

Date: 2026-11-03
Status: Implemented for W01–W04.

The owner selected Foundation as the first work area. Keep definitions as immutable
trusted operator templates and installations as separately owned workspace records.
No grant is created implicitly during installation. Scope is one channel and one
skill per grant; only the current owner can manage that installation. Capability
claims never count as authorization.

Use shared PostgreSQL membership queries for access decisions. Store grant/enablement
changes and their append-only audit record in one transaction. Lock the installation
for mutations, matching dispatch's shared lock, to serialize those decisions.
Revocation takes effect on future authorization checks; in-flight cancellation is a
separate command with its own receipt semantics.

Keep definition publication and installation management as internal APIs. The caller
must supply authenticated identity; accepting untrusted actor IDs or exposing operator
publication over HTTP is not supported. Real authentication and installation ownership
proof remain W13/W17. No new framework, provider SDK or deployable is required.

Contracts use explicit version 1.0 for invocation and events. The mock-only receipt
semantics remain provisional pending an async local/cloud interoperability spike.

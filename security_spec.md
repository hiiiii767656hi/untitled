# Security Specification: Minecraft Physics Sandbox with Portals

## 1. Data Invariants
- A user can only read and write their own UserProfile document (`users/{userId}` where `userId == request.auth.uid`).
- Non-authenticated writes or cross-user writes are strictly forbidden.
- The `uid` in the document body must match `request.auth.uid`.
- Payload sizes are strictly bounded (`displayName` <= 64 chars, `skin` <= 65536 chars).

## 2. The Dirty Dozen Payloads (Designed to Fail)
1. Unauthenticated write to `/users/user123` -> Reject (Must be signed in).
2. Authenticated user A writing to `/users/userB` -> Reject (ID mismatch).
3. Payload with `uid` !== `request.auth.uid` -> Reject (Identity spoofing).
4. `displayName` exceeding 64 characters -> Reject (Size overflow).
5. Injection of arbitrary field `isAdmin: true` -> Reject (Disallowed field).
6. Non-string `skin` payload -> Reject (Type error).
7. Negative or invalid `playerScale` (< 0.1 or > 10.0) -> Reject (Out of bounds).
8. `teleportsCount` as string instead of number -> Reject (Type mismatch).
9. Blank or oversized document ID -> Reject (ID validation).
10. Unbounded list or unknown collection query -> Reject (Default deny).
11. Write without required fields `uid` and `displayName` -> Reject (Missing required fields).
12. Attempt to delete another user's profile -> Reject (Permission denied).

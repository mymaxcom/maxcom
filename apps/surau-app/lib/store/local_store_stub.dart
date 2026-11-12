// Fallbacks for the platform factories in `deps.dart`: a platform with no
// persistent store keeps data for one run only.

import 'local_store.dart';

LocalStore androidLocalStore() => MemoryLocalStore();

LocalStore webLocalStore() => MemoryLocalStore();

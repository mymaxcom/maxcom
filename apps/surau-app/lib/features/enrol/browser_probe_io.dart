/// Android (and any VM platform): the camera is the scanner's job to open;
/// assume it exists and let the scanner report a failure.
bool cameraLikelyAvailable() => true;

/// No browser here.
String currentUserAgent() => '';

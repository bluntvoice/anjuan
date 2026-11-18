const connections = new Set();

export function trackAuthConnection(req, res, session, validate) {
  const record = { req, res, userId: session.user.id, tokenHash: session.tokenHash };
  connections.add(record);
  const timer = setInterval(() => {
    if (!validate()) res.destroy();
  }, 1000);
  timer.unref();
  const clean = () => { connections.delete(record); clearInterval(timer); };
  res.once('finish', clean); res.once('close', clean);
}
export function revokeUserConnections(userId, excludeResponse) {
  for (const item of connections) if (item.userId === userId && item.res !== excludeResponse) item.res.destroy();
}
export function revokeSessionConnections(tokenHash, excludeResponse) {
  for (const item of connections) if (item.tokenHash === tokenHash && item.res !== excludeResponse) item.res.destroy();
}

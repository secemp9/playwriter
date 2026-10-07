// Dedicated worker for errors.html: throws when told to.
self.onmessage = (e) => {
  if (e.data === 'boom') throw new Error('Lab worker error');
};

import { transitionMovie, logMovieEvent, Tx } from './movieState';

function makeTx(): Tx {
  return {
    movie: { update: jest.fn().mockResolvedValue({}) },
    movieEvent: { create: jest.fn().mockResolvedValue({}) },
  } as unknown as Tx;
}

describe('transitionMovie', () => {
  it('updates the movie state and records an event in the same call', async () => {
    const tx = makeTx();

    await transitionMovie(tx, 1, 'added', { type: 'added_to_radarr' });

    expect(tx.movie.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { state: 'added' } });
    expect(tx.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 1, type: 'added_to_radarr' },
    });
  });

  it('passes through optional detail and listId on the event', async () => {
    const tx = makeTx();

    await transitionMovie(tx, 2, 'deletion_queued', {
      type: 'deletion_queued',
      detail: 'left_list',
      listId: 10,
    });

    expect(tx.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 2, type: 'deletion_queued', detail: 'left_list', listId: 10 },
    });
  });
});

describe('logMovieEvent', () => {
  it('records an event without touching the movie state', async () => {
    const tx = makeTx();

    await logMovieEvent(tx, 3, { type: 'left_list', listId: 10 });

    expect(tx.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 3, type: 'left_list', listId: 10 },
    });
    expect(tx.movie.update).not.toHaveBeenCalled();
  });
});

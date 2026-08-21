// feedback.js — turn the matchup inputs into an explanation of the result.
// Trait advantages influence a snap; they do not predetermine it. The wording
// therefore has to acknowledge when the actual play overcame the paper edge.
import { OFF_BY_ID, DEF_BY_ID } from './playbook.js';
import { isSuccess } from './scout.js';

const scored = (play) => (play.events || []).some((event) => event.type === 'score');

export function talentFeedback(play, outcome) {
  const matchup = outcome.playerMatchup;
  if (!matchup?.offense?.player || !matchup?.defense?.player || !matchup.decisive
    || outcome.deadBall || outcome.penalty) return [];

  const notes = [];
  const offense = matchup.decisive.offense, defense = matchup.decisive.defense;
  const call = OFF_BY_ID[play.offId];
  const isPass = call?.family !== 'run';

  // A receiver can lose the paper matchup and still make the catch. Say that
  // explicitly instead of claiming the defender "took away" a release which
  // just produced a completion or touchdown.
  if (!outcome.sack && offense && defense
    && Number.isFinite(offense.value) && Number.isFinite(defense.value)) {
    const offenseHadEdge = offense.value >= defense.value;
    const offenseWonResult = isPass
      ? outcome.complete === true && !outcome.turnover
      : isSuccess(play.down, play.distance, outcome.yards || 0) && !outcome.turnover;
    const scoreSuffix = scored(play) ? ' for the touchdown' : '';

    if (offenseHadEdge && offenseWonResult) {
      notes.push(defense.key === 'range'
        ? `${matchup.defense.player} lacked the ${defense.label.toLowerCase()} to stay with ${matchup.offense.player}.`
        : `${matchup.offense.player}’s ${offense.label.toLowerCase()} beat ${matchup.defense.player}’s ${defense.label.toLowerCase()}${scoreSuffix}.`);
    } else if (!offenseHadEdge && !offenseWonResult) {
      notes.push(`${matchup.defense.player}’s ${defense.label.toLowerCase()} took away ${matchup.offense.player}’s ${offense.label.toLowerCase()}.`);
    } else if (offenseWonResult) {
      notes.push(`${matchup.defense.player} had the ${defense.label.toLowerCase()} advantage, but ${matchup.offense.player} still won the matchup${scoreSuffix}.`);
    } else {
      const ending = outcome.turnover === 'interception' ? 'the defense finished with the interception'
        : isPass ? 'the pass still fell incomplete' : 'the defense still won the down';
      notes.push(`${matchup.offense.player} had the ${offense.label.toLowerCase()} advantage, but ${ending}.`);
    }
  }

  const pressure = matchup.pressure;
  if (DEF_BY_ID[play.defId]?.rush > 4 && call?.blitzFit >= 0.7 && pressure) {
    const defenseWon = pressure.defense > pressure.offense;
    const blocker = pressure.blocker || 'the line';
    const rusher = pressure.rusher ? ` to ${pressure.rusher}` : '';
    if (outcome.sack) {
      notes.push(defenseWon
        ? `The protection identified the blitz, but ${blocker} lost its matchup${rusher}.`
        : `The protection held its matchup, but the quarterback was still sacked.`);
    } else if (defenseWon) {
      notes.push(outcome.complete
        ? `${pressure.rusher || 'The rusher'} beat ${blocker}, but the quarterback still completed the pass.`
        : `${pressure.rusher || 'The rusher'} beat ${blocker} and disrupted the throw.`);
    }
  }
  return notes;
}

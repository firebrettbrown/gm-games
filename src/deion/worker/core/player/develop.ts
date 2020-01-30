import orderBy from "lodash/orderBy";
import range from "lodash/range";
import { PLAYER } from "../../../common";
import skills from "./skills";
import { helpers, overrides, random } from "../../util";
import { MinimalPlayerRatings } from "../../../common/types";

let potEstimator:
	| ((ovr: number, age: number, pos: string) => number)
	| undefined;

if (process.env.SPORT === "football") {
	// This was generated by using bootstrapPot a bunch of times and then doing linear regression to find the
	// coefficients for predicting pot. This is needed for football because pot is calculated for many different
	// positions, making it unreasonably slow. It could be done for basketball too, if needed. See:
	// ~/Documents/BBGM/FBGM positions
	// These will need to be updated any time anything related to ratings changes!
	const coeffsByPos = {
		CB: {
			intercept: 41.22339,
			age: -1.55671,
			ovr: 1.73043,
			interaction: -0.02711,
		},
		DL: {
			intercept: 50.39196,
			age: -1.91082,
			ovr: 2.00579,
			interaction: -0.03759,
		},
		K: {
			intercept: 35.997,
			age: -1.349,
			ovr: 1.834,
			interaction: -0.032,
		},
		KR: {
			intercept: 39.62046,
			age: -1.47839,
			ovr: 1.67194,
			interaction: -0.02539,
		},
		LB: {
			intercept: 36.72401,
			age: -1.37224,
			ovr: 1.91346,
			interaction: -0.03444,
		},
		OL: {
			intercept: 38.22024,
			age: -1.44549,
			ovr: 2.13113,
			interaction: -0.04226,
		},
		P: {
			intercept: 36.09308,
			age: -1.3511,
			ovr: 1.90802,
			interaction: -0.03557,
		},
		PR: {
			intercept: 38.16013,
			age: -1.42061,
			ovr: 1.93835,
			interaction: -0.03559,
		},
		QB: {
			intercept: 47.34247,
			age: -1.78499,
			ovr: 2.12059,
			interaction: -0.04236,
		},
		RB: {
			intercept: 18.70945,
			age: -0.69679,
			ovr: 2.40819,
			interaction: -0.05307,
		},
		S: {
			intercept: 42.84427,
			age: -1.62036,
			ovr: 1.99803,
			interaction: -0.03686,
		},
		TE: {
			intercept: 28.15031,
			age: -1.05288,
			ovr: 2.27735,
			interaction: -0.04792,
		},
		WR: {
			intercept: 46.83016,
			age: -1.75311,
			ovr: 1.76216,
			interaction: -0.02886,
		},
	};

	potEstimator = (ovr: number, age: number, pos: string) => {
		// https://github.com/microsoft/TypeScript/issues/21732
		// @ts-ignore
		const coeffs = coeffsByPos[pos];
		if (!coeffs) {
			throw new Error(`Invalid position "${pos}" in potEstimator`);
		}

		return (
			coeffs.intercept +
			coeffs.age * age +
			coeffs.ovr * ovr +
			coeffs.interaction * age * ovr
		);
	};
}

// Repeatedly simulate aging up to 29, and pick the 75th percentile max
const NUM_SIMULATIONS = 20; // Higher is more accurate, but slower. Low accuracy is fine, though!

export const bootstrapPot = (
	ratings: MinimalPlayerRatings,
	age: number,
	pos?: string,
): number => {
	if (age >= 29) {
		return pos ? ratings.ovrs[pos] : ratings.ovr;
	}

	if (potEstimator) {
		if (pos === undefined) {
			throw new Error("pos is required for potEstimator");
		}

		const ovr = ratings.ovrs[pos];
		let pot = potEstimator(ovr, age, pos);
		pot += random.randInt(-2, 2);

		if (ovr > pot) {
			return ovr;
		}

		return helpers.bound(Math.round(pot), 0, 100);
	}

	const maxOvrs = range(NUM_SIMULATIONS).map(() => {
		const copiedRatings = helpers.deepCopy(ratings);
		let maxOvr = pos ? ratings.ovrs[pos] : ratings.ovr;

		for (let ageTemp = age + 1; ageTemp < 30; ageTemp++) {
			overrides.core.player.developSeason!(copiedRatings, ageTemp); // Purposely no coachingRank

			const currentOvr = overrides.core.player.ovr!(copiedRatings, pos);

			if (currentOvr > maxOvr) {
				maxOvr = currentOvr;
			}
		}

		return maxOvr;
	});
	return orderBy(maxOvrs)[Math.floor(0.75 * NUM_SIMULATIONS)];
};

/**
 * Develop (increase/decrease) player's ratings. This operates on whatever the last row of p.ratings is.
 *
 * Make sure to call updateValues after this! Otherwise, player values will be out of sync.
 *
 * @memberOf core.player
 * @param {Object} p Player object.
 * @param {number=} years Number of years to develop (default 1).
 * @param {boolean=} newPlayer Generating a new player? (default false). If true, then the player's age is also updated based on years.
 * @param {number=} coachingRank From 1 to g.get("numTeams") (default 30), where 1 is best coaching staff and g.get("numTeams") is worst. Default is 15.5
 * @return {Object} Updated player object.
 */
const develop = (
	p: {
		born: {
			loc: string;
			year: number;
		};
		draft: {
			ovr: number;
			pot: number;
			skills: string[];
		};
		pos?: string;
		ratings: MinimalPlayerRatings[];
		tid: number;
		weight: number;
	},
	years: number = 1,
	newPlayer: boolean = false,
	coachingRank: number = 15.5,
	skipPot: boolean = false, // Only for making testing or core/debug faster
) => {
	const ratings = p.ratings[p.ratings.length - 1];
	let age = ratings.season - p.born.year;

	for (let i = 0; i < years; i++) {
		// (CONFUSING!) Don't increment age for existing players developing one season (i.e. newPhasePreseason) because the season is already incremented before this function is called. But in other scenarios (new league and draft picks), the season is not changing, so age should be incremented every iteration of this loop.
		if (newPlayer || years > 1) {
			age += 1;
		}

		overrides.core.player.developSeason!(ratings, age, coachingRank);

		// In the NBA displayed weights seem to never change and seem inaccurate
		if (process.env.SPORT === "football") {
			const newWeight = overrides.core.player.genWeight!(
				ratings.hgt,
				ratings.stre,
			);
			const oldWeight = p.weight;

			if (newWeight - oldWeight > 10) {
				p.weight = oldWeight + 10;
			} else if (newWeight - oldWeight < -10) {
				p.weight = oldWeight - 10;
			} else {
				p.weight = newWeight;
			}
		}
	}

	// Run these even for players developing 0 seasons
	if (process.env.SPORT === "basketball") {
		ratings.ovr = overrides.core.player.ovr!(ratings);

		if (!skipPot) {
			ratings.pot = bootstrapPot(ratings, age);
		}

		if (p.hasOwnProperty("pos") && typeof p.pos === "string") {
			// Must be a custom league player, let's not rock the boat
			ratings.pos = p.pos;
		} else {
			ratings.pos = overrides.core.player.pos!(ratings);
		}
	} else {
		let pos;
		let maxOvr = -Infinity; // A player can never have KR or PR as his main position

		const bannedPositions = ["KR", "PR"];
		ratings.ovrs = overrides.common.constants.POSITIONS.reduce((ovrs, pos2) => {
			ovrs[pos2] = overrides.core.player.ovr!(ratings, pos2);

			if (!bannedPositions.includes(pos2) && ovrs[pos2] > maxOvr) {
				pos = pos2;
				maxOvr = ovrs[pos2];
			}

			return ovrs;
		}, {});

		if (!skipPot) {
			ratings.pots = overrides.common.constants.POSITIONS.reduce(
				(pots, pos2) => {
					pots[pos2] = bootstrapPot(ratings, age, pos2);
					return pots;
				},
				{},
			);
		}

		if (pos === undefined) {
			throw new Error("Should never happen");
		}

		ratings.ovr = ratings.ovrs[pos];
		ratings.pot = ratings.pots[pos];

		if (p.hasOwnProperty("pos") && typeof p.pos === "string") {
			// Must be a manually specified position
			ratings.pos = p.pos;
		} else {
			ratings.pos = pos;
		}
	}

	ratings.skills = skills(ratings);

	if (p.tid === PLAYER.UNDRAFTED) {
		p.draft.ovr = ratings.ovr;

		if (!skipPot) {
			p.draft.pot = ratings.pot;
		}

		p.draft.skills = ratings.skills;
	}

	if (newPlayer) {
		p.born.year -= years;
	}
};

export default develop;
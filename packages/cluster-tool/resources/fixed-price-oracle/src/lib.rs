//! Local-validator fixture for the production outpost's Chainlink CPI client.
//! Installed only at genesis by opted-in flow clusters; never deployed remotely.

use borsh::BorshSerialize;
use chainlink_solana::Round;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    program::set_return_data,
    program_error::ProgramError,
    pubkey,
    pubkey::Pubkey,
    sysvar::Sysvar,
};

solana_program::declare_id!("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
const FEED: Pubkey = pubkey!("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");
const QUERY_DISCRIMINATOR: [u8; 8] = [0x27, 0xfb, 0x82, 0x9f, 0x2e, 0x88, 0xa4, 0xa9];
const PRICE: i128 = 10_000_000_000;
const DECIMALS: u8 = 8;

entrypoint!(process_instruction);

/// Serve the two read-only queries used by the real Chainlink client.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if program_id != &id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    let feed = next_account_info(&mut accounts.iter())?;
    if accounts.len() != 1 || feed.key != &FEED || feed.owner != program_id {
        return Err(ProgramError::InvalidAccountData);
    }
    let query = parse_query(instruction_data)?;
    let clock = if query == Query::LatestRoundData {
        Clock::get()?
    } else {
        Clock::default()
    };
    set_return_data(&response(query, &clock)?);
    Ok(())
}

#[derive(Debug, PartialEq)]
enum Query {
    Decimals,
    LatestRoundData,
}

fn parse_query(data: &[u8]) -> Result<Query, ProgramError> {
    if data.len() != 9 || data[..8] != QUERY_DISCRIMINATOR {
        return Err(ProgramError::InvalidInstructionData);
    }
    // Borsh discriminants from chainlink_solana's private Query enum.
    match data[8] {
        1 => Ok(Query::Decimals),
        4 => Ok(Query::LatestRoundData),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn response(query: Query, clock: &Clock) -> Result<Vec<u8>, ProgramError> {
    match query {
        Query::Decimals => Ok(vec![DECIMALS]),
        Query::LatestRoundData => {
            let timestamp =
                u32::try_from(clock.unix_timestamp).map_err(|_| ProgramError::InvalidArgument)?;
            Round {
                round_id: 1,
                slot: clock.slot,
                timestamp,
                answer: PRICE,
            }
            .try_to_vec()
            .map_err(|_| ProgramError::InvalidInstructionData)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::BorshDeserialize;

    fn request(scope: u8) -> Vec<u8> {
        let mut data = QUERY_DISCRIMINATOR.to_vec();
        data.push(scope);
        data
    }

    #[test]
    fn serves_a_hundred_dollars_in_the_real_clients_round_format() {
        let clock = Clock {
            slot: 123,
            unix_timestamp: 1_800_000_000,
            ..Clock::default()
        };
        let bytes = response(parse_query(&request(4)).unwrap(), &clock).unwrap();
        let round = Round::try_from_slice(&bytes).unwrap();
        let decimals =
            u8::try_from_slice(&response(parse_query(&request(1)).unwrap(), &clock).unwrap())
                .unwrap();
        assert_eq!(round.answer, 100 * 10i128.pow(decimals.into()));
        assert_ne!(round.round_id, 0);
        assert_eq!(round.slot, clock.slot);
        assert_eq!(i64::from(round.timestamp), clock.unix_timestamp);
    }

    #[test]
    fn refreshes_round_time_without_changing_the_price() {
        for timestamp in [1_800_000_000, 1_800_004_000] {
            let clock = Clock {
                unix_timestamp: timestamp,
                ..Clock::default()
            };
            let round =
                Round::try_from_slice(&response(Query::LatestRoundData, &clock).unwrap()).unwrap();
            assert_eq!(i64::from(round.timestamp), timestamp);
            assert_eq!(round.answer, PRICE);
        }
    }

    #[test]
    fn refuses_malformed_or_unsupported_queries() {
        assert_eq!(parse_query(&[]), Err(ProgramError::InvalidInstructionData));
        let mut bad = request(4);
        bad[0] ^= 1;
        assert!(parse_query(&bad).is_err());
        bad = request(4);
        bad.push(0);
        assert!(parse_query(&bad).is_err());
        for scope in [0, 2, 3, 5, 255] {
            assert!(parse_query(&request(scope)).is_err());
        }
    }

    #[test]
    fn refuses_a_timestamp_that_cannot_be_encoded_as_chainlink_round_data() {
        for timestamp in [-1, i64::from(u32::MAX) + 1] {
            let clock = Clock {
                unix_timestamp: timestamp,
                ..Clock::default()
            };
            assert_eq!(
                response(Query::LatestRoundData, &clock),
                Err(ProgramError::InvalidArgument)
            );
        }
    }

    #[test]
    fn rejects_a_different_program_or_feed_identity() {
        assert_eq!(
            process_instruction(&Pubkey::new_unique(), &[], &request(1)),
            Err(ProgramError::IncorrectProgramId)
        );
        assert_eq!(
            process_instruction(&id(), &[], &request(1)),
            Err(ProgramError::NotEnoughAccountKeys)
        );
        let key = Pubkey::new_unique();
        let owner = id();
        let mut lamports = 1;
        let mut data = [];
        let account = AccountInfo::new(
            &key,
            false,
            false,
            &mut lamports,
            &mut data,
            &owner,
            false,
            0,
        );
        assert_eq!(
            process_instruction(&id(), &[account], &request(1)),
            Err(ProgramError::InvalidAccountData)
        );
    }
}

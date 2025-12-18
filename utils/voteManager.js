class VoteManager {
    constructor() {
        this.activeVotes = new Map(); // voteId -> vote data
    }

    hasActiveVote() {
        return this.activeVotes.size > 0;
    }

    getActiveVote() {
        if (this.activeVotes.size === 0) return null;
        // Return the first (and should be only) active vote
        const [voteId, voteData] = this.activeVotes.entries().next().value;
        return {
            voteId: voteData.voteId,
            trackUri: voteData.trackUri,
            trackName: voteData.trackName,
            trackArtist: voteData.trackArtist,
            initiator: voteData.initiator,
            onlineCount: voteData.onlineCount,
            totalOnline: voteData.onlineCount,
            yesVotes: voteData.yesVotes.size,
            noVotes: voteData.noVotes.size,
            expiresIn: voteData.expiresIn - (Date.now() - voteData.startTime)
        };
    }

    startBanVote(voteId, trackUri, trackName, trackArtist, initiator, onlineCount, onExpireCallback) {
        const requiredVotes = Math.ceil(onlineCount / 2); // Simple majority
        
        console.log(`Starting ban vote: onlineCount=${onlineCount}, requiredVotes=${requiredVotes}`);
        
        const voteData = {
            voteId,
            trackUri,
            trackName,
            trackArtist,
            initiator,
            onlineCount,
            requiredVotes,
            yesVotes: new Set([initiator]), // Initiator automatically votes yes
            noVotes: new Set(),
            startTime: Date.now(),
            expiresIn: 45000, // 45 seconds
            timeoutId: null
        };

        this.activeVotes.set(voteId, voteData);

        // Auto-cleanup after expiration with callback
        const timeoutId = setTimeout(() => {
            if (this.activeVotes.has(voteId)) {
                const yesVotes = voteData.yesVotes.size;
                const noVotes = voteData.noVotes.size;
                console.log(`Vote expired: yesVotes=${yesVotes}, noVotes=${noVotes}, required=${voteData.requiredVotes}`);
                this.activeVotes.delete(voteId);
                
                // Call the expiration callback if provided
                if (onExpireCallback) {
                    onExpireCallback({
                        trackName: voteData.trackName,
                        yesVotes,
                        noVotes,
                        reason: 'time expired'
                    });
                }
            } else {
                console.log('Vote already completed, skipping expiration callback');
            }
        }, voteData.expiresIn);

        // Store the timeout ID so we can clear it if vote ends early
        voteData.timeoutId = timeoutId;

        return voteData;
    }

    castVote(voteId, userId, vote) {
        const voteData = this.activeVotes.get(voteId);
        if (!voteData) {
            return { error: 'Vote not found or expired' };
        }

        // Check if user already voted
        const alreadyVotedYes = voteData.yesVotes.has(userId);
        const alreadyVotedNo = voteData.noVotes.has(userId);
        
        if ((vote === 'yes' && alreadyVotedYes) || (vote === 'no' && alreadyVotedNo)) {
            return { error: 'You have already voted' };
        }

        // Remove from opposite set if they're changing their vote
        if (vote === 'yes') {
            voteData.noVotes.delete(userId);
            voteData.yesVotes.add(userId);
        } else {
            voteData.yesVotes.delete(userId);
            voteData.noVotes.add(userId);
        }

        // Check if vote passed (majority yes)
        console.log(`Vote check: yesVotes=${voteData.yesVotes.size}, noVotes=${voteData.noVotes.size}, required=${voteData.requiredVotes}`);
        if (voteData.yesVotes.size >= voteData.requiredVotes) {
            console.log('Vote PASSED! Clearing timeout and deleting from activeVotes');
            // Clear the expiration timeout since vote passed early
            if (voteData.timeoutId) {
                clearTimeout(voteData.timeoutId);
            }
            this.activeVotes.delete(voteId);
            return { 
                passed: true, 
                yesVotes: voteData.yesVotes.size,
                noVotes: voteData.noVotes.size,
                trackUri: voteData.trackUri,
                trackName: voteData.trackName,
                trackArtist: voteData.trackArtist
            };
        }

        // Check if vote failed (majority no OR not enough yes votes possible)
        const remainingVoters = voteData.onlineCount - voteData.yesVotes.size - voteData.noVotes.size;
        const canStillWin = voteData.yesVotes.size + remainingVoters >= voteData.requiredVotes;
        const majorityNo = voteData.noVotes.size >= voteData.requiredVotes;
        
        if (!canStillWin || majorityNo) {
            console.log('Vote FAILED! Clearing timeout and deleting from activeVotes');
            // Clear the expiration timeout since vote failed early
            if (voteData.timeoutId) {
                clearTimeout(voteData.timeoutId);
            }
            this.activeVotes.delete(voteId);
            return { 
                failed: true,
                yesVotes: voteData.yesVotes.size,
                noVotes: voteData.noVotes.size,
                trackName: voteData.trackName,
                reason: majorityNo ? 'majority voted no' : 'not enough votes to pass'
            };
        }

        return {
            yesVotes: voteData.yesVotes.size,
            noVotes: voteData.noVotes.size,
            onlineCount: voteData.onlineCount,
            trackName: voteData.trackName
        };
    }

    cleanupExpiredVotes() {
        const now = Date.now();
        for (const [voteId, voteData] of this.activeVotes.entries()) {
            if (now - voteData.startTime >= voteData.expiresIn) {
                this.activeVotes.delete(voteId);
            }
        }
    }
}

module.exports = VoteManager;
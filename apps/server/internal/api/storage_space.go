package api

import "errors"

func checkedStorageAvailableBytes(blocks, blockSize uint64) (uint64, error) {
	// The value is consumed as a JavaScript Number by the existing admin UI.
	const maxExactJSONInteger = uint64(1<<53 - 1)
	if blockSize == 0 || blocks > maxExactJSONInteger/blockSize {
		return 0, errors.New("磁盘可用空间超过当前界面的精确数值范围")
	}
	return blocks * blockSize, nil
}
